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
        .expect("liquidity fixture account must exist")
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

fn fact_evidence(
    state: &str,
    source: &str,
    observed_at: Option<&str>,
    expires_at: Option<&str>,
    reasons: &[&str],
) -> Value {
    json!({
        "state": state,
        "source": source,
        "observedAt": observed_at,
        "expiresAt": expires_at,
        "reasons": reasons,
    })
}

fn actual_partial_account_request() -> Value {
    let mut input = base_request();
    input["financialSnapshot"]["coverage"]["accounts"] = json!("partial");

    // The Actual connector can return a usable balance while leaving account
    // type, ownership, currency, holds, and institution freshness unknown.
    let checking = account_mut(&mut input, "checking").clone();
    input["financialSnapshot"]["liquidity"]["accounts"] = json!([checking]);
    let checking_policy = input["liquidityPolicy"]["accounts"]
        .as_array()
        .expect("liquidity policy accounts must be an array")
        .iter()
        .find(|account| account["accountId"] == "checking")
        .cloned()
        .expect("liquidity policy must contain checking");
    input["liquidityPolicy"]["accounts"] = json!([checking_policy]);
    input["liquidityPolicy"]["transferRoutes"] = json!([]);

    set_account_balance(&mut input, "checking", 15_000);
    set_category_availability(&mut input, "food", 2_000);
    let account = account_mut(&mut input, "checking");
    account["currency"] = json!("USD");
    account["kind"] = json!("unknown");
    account["owned"] = json!(false);
    account["holds"] = money(0, "USD");
    account["currencyEvidence"] = fact_evidence(
        "unknown",
        "actual_ledger",
        None,
        None,
        &["account_currency_not_exposed"],
    );
    account["kindEvidence"] = fact_evidence(
        "unknown",
        "actual_ledger",
        None,
        None,
        &["account_type_not_exposed"],
    );
    account["ownershipEvidence"] = fact_evidence(
        "unknown",
        "actual_ledger",
        None,
        None,
        &["account_ownership_not_exposed"],
    );
    account["freshnessEvidence"] = fact_evidence(
        "unknown",
        "actual_ledger",
        None,
        None,
        &["institution_freshness_not_exposed"],
    );
    account["holdsEvidence"] = fact_evidence(
        "unknown",
        "actual_ledger",
        None,
        None,
        &["institution_holds_not_exposed"],
    );
    account["balanceEvidence"] = fact_evidence(
        "known",
        "actual_ledger",
        Some(EVALUATED_AT),
        None,
        &["ledger_balance_not_institution_freshness"],
    );
    account["activityEvidence"] =
        fact_evidence("known", "actual_ledger", Some(EVALUATED_AT), None, &[]);
    account["scheduleEvidence"] =
        fact_evidence("known", "actual_ledger", Some(EVALUATED_AT), None, &[]);

    input["financialSnapshot"]["observations"] = json!([
        {
            "kind": "account_collection_coverage",
            "scope": { "kind": "global" },
            "state": "complete",
            "observedAt": EVALUATED_AT,
            "evidence": []
        },
        {
            "kind": "account_freshness",
            "scope": { "kind": "account", "id": "checking" },
            "state": "unknown",
            "observedAt": null,
            "evidence": [{
                "evidenceId": "checking",
                "kind": "account",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "account_coverage",
            "scope": { "kind": "account", "id": "checking" },
            "state": "complete",
            "observedAt": EVALUATED_AT,
            "evidence": [{
                "evidenceId": "checking",
                "kind": "account",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "account_type",
            "scope": { "kind": "account", "id": "checking" },
            "state": "unknown",
            "observedAt": null,
            "evidence": [{
                "evidenceId": "checking",
                "kind": "account",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "account_balance",
            "scope": { "kind": "account", "id": "checking" },
            "state": "complete",
            "observedAt": EVALUATED_AT,
            "evidence": [{
                "evidenceId": "checking",
                "kind": "account",
                "authorized": true,
                "redaction": "visible"
            }]
        }
    ]);

    // This models the server-bound observation saved from the same ledger
    // capture: it supplies effective dated facts but does not rewrite source
    // observations or collection coverage.
    let account = account_mut(&mut input, "checking");
    let attested = fact_evidence(
        "known",
        "user_attested",
        Some("2026-09-06T09:59:00Z"),
        Some("2026-09-06T10:15:00Z"),
        &["explicit_user_attestation_not_bank_sync"],
    );
    account["currency"] = json!("USD");
    account["kind"] = json!("cash");
    account["owned"] = json!(true);
    account["holds"] = money(0, "USD");
    account["currencyEvidence"] = attested.clone();
    account["kindEvidence"] = attested.clone();
    account["ownershipEvidence"] = attested.clone();
    account["freshnessEvidence"] = attested;
    account["holdsEvidence"] = fact_evidence(
        "known",
        "user_attested",
        Some("2026-09-06T09:59:00Z"),
        Some("2026-09-06T10:15:00Z"),
        &["explicit_user_attestation_not_bank_sync"],
    );
    input
}

fn collection_receipt(input: &Value) -> &Value {
    input["financialSnapshot"]["observations"]
        .as_array()
        .expect("source observations must be an array")
        .first()
        .expect("partial Actual fixture must start with a collection receipt")
}
fn assert_collection_rejected(input: Value, label: &str) {
    let card = evaluate(input);
    assert_eq!(outcome(&card), "insufficient_data", "{label}");
    assert!(
        card["after"].is_null(),
        "{label} must not expose an after-state"
    );
    assert!(
        has_text(&card["blockers"], "incomplete_accounts_coverage"),
        "{label} must retain the account coverage blocker: {}",
        card["blockers"]
    );
}

#[test]
fn actual_partial_accounts_with_matching_attestation_are_funded_and_ready() {
    let card = evaluate(actual_partial_account_request());

    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(card["items"][0]["outcome"], "funded_now");
    assert_eq!(card["budgetFundingStatus"], "funded");
    assert_eq!(card["paymentLiquidityStatus"], "ready");
    assert_eq!(
        minor_units(&category_state(&card, "before", "food")["availability"]),
        "2000"
    );
    assert_eq!(
        minor_units(&category_state(&card, "after", "food")["availability"]),
        "0"
    );

    let before_account = card["before"]["accounts"]
        .as_array()
        .expect("before state must expose account capacities")
        .iter()
        .find(|account| account["accountId"] == "checking")
        .expect("before state must contain checking");
    let after_account = card["after"]["accounts"]
        .as_array()
        .expect("after state must expose account capacities")
        .iter()
        .find(|account| account["accountId"] == "checking")
        .expect("after state must contain checking");
    assert_eq!(minor_units(&before_account["safeSpendingCapacity"]), "5000");
    assert_eq!(minor_units(&after_account["safeSpendingCapacity"]), "3000");
}

#[test]
fn cash_account_ignores_inapplicable_credit_obligation_coverage() {
    let mut input = actual_partial_account_request();
    input["financialSnapshot"]["observations"]
        .as_array_mut()
        .expect("source observations must be an array")
        .push(json!({
            "kind": "credit_card_obligation_coverage",
            "scope": { "kind": "account", "id": "checking" },
            "state": "unavailable",
            "observedAt": Value::Null,
            "evidence": [{
                "evidenceId": "checking",
                "kind": "account",
                "authorized": true,
                "redaction": "visible"
            }]
        }));

    let card = evaluate(input);
    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(card["budgetFundingStatus"], "funded");
    assert_eq!(card["paymentLiquidityStatus"], "ready");
}

#[test]
fn actual_partial_accounts_reject_missing_invalid_or_duplicate_collection_receipts() {
    let mut missing = actual_partial_account_request();
    missing["financialSnapshot"]["observations"]
        .as_array_mut()
        .expect("source observations must be an array")
        .remove(0);
    assert_collection_rejected(missing, "missing collection receipt");

    let mut stale = actual_partial_account_request();
    stale["financialSnapshot"]["observations"][0]["state"] = json!("stale");
    stale["financialSnapshot"]["observations"][0]["observedAt"] = json!("2026-09-06T08:00:00Z");
    assert_collection_rejected(stale, "stale collection receipt");

    let mut future = actual_partial_account_request();
    future["financialSnapshot"]["observations"][0]["observedAt"] = json!("2026-09-06T10:01:00Z");
    assert_collection_rejected(future, "future collection receipt");

    let mut mismatched_scope = actual_partial_account_request();
    mismatched_scope["financialSnapshot"]["observations"][0]["scope"] =
        json!({ "kind": "account", "id": "checking" });
    assert_collection_rejected(mismatched_scope, "account-scoped collection receipt");

    let mut duplicate = actual_partial_account_request();
    let duplicate_receipt = collection_receipt(&duplicate).clone();
    duplicate["financialSnapshot"]["observations"]
        .as_array_mut()
        .expect("source observations must be an array")
        .push(duplicate_receipt);
    assert_collection_rejected(duplicate, "duplicate collection receipts");
}

#[test]
fn partial_account_attestations_require_dated_replacements_and_exact_account_sets() {
    let mut missing_attestation_time = actual_partial_account_request();
    account_mut(&mut missing_attestation_time, "checking")["freshnessEvidence"]["observedAt"] =
        Value::Null;
    assert_collection_rejected(
        missing_attestation_time,
        "missing effective freshness observation time",
    );

    let mut mismatched_source_accounts = actual_partial_account_request();
    mismatched_source_accounts["financialSnapshot"]["observations"]
        .as_array_mut()
        .expect("source observations must be an array")
        .iter_mut()
        .find(|observation| observation["kind"] == "account_balance")
        .expect("partial fixture must contain account balance coverage")["scope"] =
        json!({ "kind": "account", "id": "savings" });
    assert_collection_rejected(
        mismatched_source_accounts,
        "source and effective account sets must match",
    );
}

#[test]
fn actual_partial_account_fix_does_not_clear_unrelated_transfer_ambiguity() {
    let mut input = actual_partial_account_request();
    input["financialSnapshot"]["observations"]
        .as_array_mut()
        .expect("source observations must be an array")
        .push(json!({
            "kind": "transfer_ambiguity",
            "scope": { "kind": "transaction", "id": "unrelated-transfer" },
            "state": "ambiguous",
            "observedAt": EVALUATED_AT,
            "evidence": [{
                "evidenceId": "unrelated-transfer",
                "kind": "transaction",
                "authorized": true,
                "redaction": "visible"
            }]
        }));

    let card = evaluate(input);
    assert_eq!(outcome(&card), "insufficient_data");
    assert!(card["after"].is_null());
    assert!(has_text(
        &card["blockers"],
        "material_observation_transferambiguity"
    ));
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

    let card = evaluate(input.clone());

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
    input["claimSet"]["bundles"][0]["effects"][0]["economicObligationId"] =
        json!("schedule:shared-schedule:2026-09-10:category:food");
    input["claimSet"]["bundles"][0]["effects"][0]["sourceEconomicObligationId"] =
        json!("schedule:shared-schedule:2026-09-10");
    let scoped = evaluate(input);
    assert_eq!(outcome(&scoped), "funded_now");
    let before = category_state(&scoped, "before", "food");
    assert_eq!(minor_units(&before["commitments"]), "1000");
    assert_eq!(minor_units(&before["reservations"]), "0");
    let obligations = scoped["before"]["obligations"].as_array().unwrap();
    assert_eq!(obligations.len(), 1);
    assert_eq!(obligations[0]["classification"], "commitment");
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

#[test]
fn duplicate_cart_identity_and_unknown_priority_cannot_produce_a_safe_card() {
    let mut duplicate = base_request();
    set_account_balance(&mut duplicate, "checking", 30_000);
    set_category_availability(&mut duplicate, "food", 4_000);
    let mut second = duplicate["items"][0].clone();
    second["amount"] = money(1_000, "USD");
    duplicate["items"].as_array_mut().unwrap().push(second);

    let duplicated = evaluate(duplicate);
    assert_eq!(outcome(&duplicated), "insufficient_data");
    assert!(duplicated["after"].is_null());
    assert!(has_text(&duplicated["blockers"], "duplicate"));

    let mut unknown_priority = base_request();
    set_account_balance(&mut unknown_priority, "checking", 30_000);
    unknown_priority["items"][0]["priority"] = json!("unreviewed");
    let unknown = evaluate(unknown_priority);
    assert_eq!(outcome(&unknown), "insufficient_data");
    assert!(unknown["after"].is_null());
    assert!(has_text(&unknown["blockers"], "priority"));
}
#[test]
fn protected_policy_uses_purchase_period_and_preserves_future_category_amount() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 100_000);
    set_account_balance(&mut input, "savings", 100_000);
    set_category_availability(&mut input, "food", 20_000);
    add_category(&mut input, "food", 50_000);
    input["financialSnapshot"]["liquidity"]["categories"][1]["cashBucketId"] =
        json!("food:2026-10");
    input["financialSnapshot"]["liquidity"]["categories"][1]["asOfMonth"] = json!("2026-10");
    input["financialSnapshot"]["liquidity"]["categories"][1]["periodKind"] = json!("future");
    set_item_amount(&mut input, 0, 15_000, "USD");
    let policy = category_policy_mut(&mut input, "food");
    policy["kind"] = json!("protected");
    policy["minimumRetained"] = money(10_000, "USD");

    let card = evaluate(input);

    assert_eq!(outcome(&card), "plan_breaking");
    assert_eq!(card["items"][0]["outcome"], "plan_breaking");
    assert_eq!(card["before"]["categories"].as_array().unwrap().len(), 2);
    assert_eq!(card["after"]["categories"].as_array().unwrap().len(), 2);

    let before_september = category_state_for_period(&card, "before", "food", "2026-09");
    let before_october = category_state_for_period(&card, "before", "food", "2026-10");
    let after_september = category_state_for_period(&card, "after", "food", "2026-09");
    let after_october = category_state_for_period(&card, "after", "food", "2026-10");
    assert_eq!(minor_units(&before_september["availability"]), "20000");
    assert_eq!(minor_units(&before_october["availability"]), "50000");
    assert_eq!(minor_units(&after_september["availability"]), "5000");
    assert_eq!(minor_units(&after_october["availability"]), "50000");
}

#[test]
fn mismatched_claim_and_account_obligation_fail_closed_without_donor_plan() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 100_000);
    set_account_balance(&mut input, "savings", 100_000);
    set_category_availability(&mut input, "food", 0);
    add_category(&mut input, "reserve", 6_000);
    add_category_policy(&mut input, "reserve", "ordinary", true, 1_000, 0);
    set_item_amount(&mut input, 0, 2_000, "USD");
    input["claimSet"]["bundles"] = json!([{
        "id": "mismatched-claim",
        "creationSnapshotId": SNAPSHOT_ID,
        "creationPolicyVersion": POLICY_VERSION,
        "state": "active",
        "expiresAt": "2026-09-06T18:00:00Z",
        "initiated": false,
        "effects": [{
            "kind": "category",
            "resourceId": "reserve",
            "amount": money(2_000, "USD"),
            "economicObligationId": "shared-obligation:category:reserve",
            "sourceEconomicObligationId": "shared-obligation",
            "categoryId": "reserve",
            "includedInBalance": false,
            "matchedTransactionIds": []
        }]
    }]);
    account_mut(&mut input, "checking")["obligations"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "mismatched-obligation",
            "economicObligationId": "shared-obligation",
            "categoryId": "reserve",
            "amount": money(1_000, "USD"),
            "dueAt": "2026-09-10T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }));

    let card = evaluate(input);

    assert_eq!(outcome(&card), "insufficient_data");
    assert!(card["after"].is_null());
    assert!(card["fundingPaths"].as_array().unwrap().is_empty());
    assert!(card["authorizationRequirements"]
        .as_array()
        .unwrap()
        .is_empty());
}

#[test]
fn timezone_offsets_preserve_claim_obligation_and_evidence_instants() {
    let mut offset_claim = base_request();
    set_account_balance(&mut offset_claim, "checking", 100_000);
    set_account_balance(&mut offset_claim, "savings", 100_000);
    set_category_availability(&mut offset_claim, "food", 0);
    add_category(&mut offset_claim, "reserve", 5_000);
    add_category_policy(&mut offset_claim, "reserve", "ordinary", true, 2_000, 0);
    set_item_amount(&mut offset_claim, 0, 2_000, "USD");
    add_claim(
        &mut offset_claim,
        "offset-claim",
        "reserve",
        2_000,
        "2026-09-06T09:00:00-02:00",
    );

    let claim_card = evaluate(offset_claim);

    assert_eq!(outcome(&claim_card), "insufficient_data");
    assert!(claim_card["before"].is_null());
    assert!(claim_card["after"].is_null());
    assert!(claim_card["fundingPaths"].as_array().unwrap().is_empty());
    assert!(claim_card["authorizationRequirements"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(has_text(
        &claim_card["blockers"],
        "invalid_canonical_timestamp"
    ));

    let mut offset_obligation = base_request();
    set_account_balance(&mut offset_obligation, "checking", 100_000);
    set_account_balance(&mut offset_obligation, "savings", 100_000);
    set_category_availability(&mut offset_obligation, "food", 0);
    add_category(&mut offset_obligation, "reserve", 5_000);
    add_category_policy(
        &mut offset_obligation,
        "reserve",
        "ordinary",
        true,
        2_000,
        0,
    );
    set_item_amount(&mut offset_obligation, 0, 2_000, "USD");
    offset_obligation["context"]["horizon"]["endsAt"] = json!("2026-09-06T23:00:00Z");
    account_mut(&mut offset_obligation, "checking")["obligations"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "offset-obligation",
            "economicObligationId": "offset-obligation",
            "categoryId": "reserve",
            "amount": money(2_000, "USD"),
            "dueAt": "2026-09-07T00:30:00+02:00",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }));

    let obligation_card = evaluate(offset_obligation);

    assert_eq!(outcome(&obligation_card), "insufficient_data");
    assert!(obligation_card["before"].is_null());
    assert!(obligation_card["after"].is_null());
    assert!(obligation_card["fundingPaths"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(obligation_card["authorizationRequirements"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(has_text(
        &obligation_card["blockers"],
        "invalid_canonical_timestamp"
    ));

    let mut offset_evidence = base_request();
    set_account_balance(&mut offset_evidence, "checking", 13_000);
    let evidence = &mut category_mut(&mut offset_evidence, "food")["evidence"];
    evidence["observedAt"] = json!("2026-09-06T11:00:00+02:00");
    evidence["expiresAt"] = json!("2026-09-06T09:00:00-02:00");

    let evidence_card = evaluate(offset_evidence);

    assert_eq!(outcome(&evidence_card), "insufficient_data");
    assert!(evidence_card["before"].is_null());
    assert!(evidence_card["after"].is_null());
    assert!(evidence_card["fundingPaths"].as_array().unwrap().is_empty());
    assert!(evidence_card["authorizationRequirements"]
        .as_array()
        .unwrap()
        .is_empty());
    assert!(has_text(
        &evidence_card["blockers"],
        "invalid_canonical_timestamp"
    ));
    assert!(!has_text(&evidence_card["blockers"], "stale"));
    assert!(!has_text(&evidence_card["blockers"], "future"));
}

#[test]
fn blocked_card_omits_unauthorized_redacted_evidence_ids() {
    let mut input = base_request();
    input["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "kind": "account_freshness",
            "scope": { "kind": "account", "id": "checking" },
            "state": "stale",
            "observedAt": EVALUATED_AT,
            "evidence": [{
                "evidenceId": "private-restricted-evidence-id",
                "kind": "bank_sync",
                "authorized": false,
                "redaction": "redacted"
            }]
        }));

    let card = evaluate(input);

    assert_eq!(outcome(&card), "insufficient_data");
    assert!(has_text(
        &card["blockers"],
        "material_observation_accountfreshness"
    ));
    let evidence_ids: Vec<&str> = card["evidence"]
        .as_array()
        .unwrap()
        .iter()
        .map(|reference| reference["evidenceId"].as_str().unwrap())
        .collect();
    assert_eq!(evidence_ids, vec!["checking-freshness"]);
}

#[test]
fn aggregate_category_shortfall_does_not_overwrite_first_funded_item() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 10_000);
    set_item_amount(&mut input, 0, 10_000, "USD");
    let mut second = input["items"][0].clone();
    second["id"] = json!("purchase-2");
    input["items"].as_array_mut().unwrap().push(second);

    let card = evaluate(input);

    assert_eq!(outcome(&card), "cash_available_but_unfunded");
    assert_eq!(card["budgetFundingStatus"], "unfunded");
    assert_eq!(card["items"][0]["outcome"], "funded_now");
    assert_eq!(card["items"][1]["outcome"], "cash_available_but_unfunded");
}

#[test]
fn selected_account_follows_first_requested_item_not_engine_sort_order() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_account_balance(&mut input, "savings", 30_000);
    input["liquidityPolicy"]["accounts"][1]["paymentEligible"] = json!(true);
    set_category_availability(&mut input, "food", 2_000);

    let mut first = input["items"][0].clone();
    first["id"] = json!("z-requested-first");
    first["amount"] = money(1_000, "USD");
    first["routeSelection"]["explicitAccountId"] = json!("checking");
    let mut second = first.clone();
    second["id"] = json!("a-engine-first");
    second["routeSelection"]["explicitAccountId"] = json!("savings");
    input["items"] = json!([first, second]);

    let card = evaluate(input);

    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(card["selectedAccountId"], "checking");
    assert_eq!(card["selectionSource"], "explicit");
    assert_eq!(card["items"][0]["id"], "z-requested-first");
    assert_eq!(card["items"][0]["selectedAccountId"], "checking");
}

fn category_state_for_period<'a>(
    card: &'a Value,
    side: &str,
    category_id: &str,
    as_of_month: &str,
) -> &'a Value {
    card[side]["categories"]
        .as_array()
        .expect("DecisionCard state categories must be an array")
        .iter()
        .find(|category| {
            category["categoryId"] == category_id && category["asOfMonth"] == as_of_month
        })
        .unwrap_or_else(|| {
            panic!("{side} state must contain {category_id} for period {as_of_month}")
        })
}
#[test]
fn cart_quantity_and_line_total_allocations_reduce_each_category_and_account_exactly() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 4_000);
    add_category(&mut input, "household", 3_000);
    add_category_policy(&mut input, "household", "ordinary", false, 0, 0);
    set_item_amount(&mut input, 0, 800, "USD");
    input["items"][0]["quantity"] = json!(2);
    input["items"][0]["categoryAllocations"] = json!([
        { "categoryId": "food", "amount": money(600, "USD") },
        { "categoryId": "household", "amount": money(1_000, "USD") }
    ]);

    let card = evaluate(input);

    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(minor_units(&card["cart"]["subtotal"]), "1600");
    assert_eq!(minor_units(&card["cart"]["tax"]), "0");
    assert_eq!(minor_units(&card["cart"]["fee"]), "0");
    assert_eq!(minor_units(&card["cart"]["discount"]), "0");
    assert_eq!(minor_units(&card["cart"]["total"]), "1600");

    let category_charge = |category_id: &str| {
        card["cart"]["categoryCharges"]
            .as_array()
            .expect("cart category charges must be an array")
            .iter()
            .find(|charge| charge["categoryId"] == category_id)
            .unwrap_or_else(|| panic!("cart must expose category charge {category_id}"))
    };
    assert_eq!(minor_units(&category_charge("food")["amount"]), "600");
    assert_eq!(minor_units(&category_charge("household")["amount"]), "1000");
    let checking_charge = card["cart"]["accountCharges"]
        .as_array()
        .expect("cart account charges must be an array")
        .iter()
        .find(|charge| charge["accountId"] == "checking")
        .expect("cart must expose the selected account charge");
    assert_eq!(minor_units(&checking_charge["amount"]), "1600");

    assert_eq!(
        minor_units(&category_state(&card, "before", "food")["availability"]),
        "4000"
    );
    assert_eq!(
        minor_units(&category_state(&card, "after", "food")["availability"]),
        "3400"
    );
    assert_eq!(
        minor_units(&category_state(&card, "before", "household")["availability"]),
        "3000"
    );
    assert_eq!(
        minor_units(&category_state(&card, "after", "household")["availability"]),
        "2000"
    );
    let checking_after = card["after"]["accounts"]
        .as_array()
        .expect("after account state must be an array")
        .iter()
        .find(|account| account["accountId"] == "checking")
        .expect("after state must contain checking");
    assert_eq!(
        minor_units(&checking_after["safeSpendingCapacity"]),
        "18400"
    );
}

#[test]
fn invalid_cart_allocation_or_checked_quantity_overflow_is_insufficient_without_after_state() {
    let mut mismatched = base_request();
    set_account_balance(&mut mismatched, "checking", 30_000);
    set_category_availability(&mut mismatched, "food", 4_000);
    add_category(&mut mismatched, "household", 3_000);
    add_category_policy(&mut mismatched, "household", "ordinary", false, 0, 0);
    set_item_amount(&mut mismatched, 0, 800, "USD");
    mismatched["items"][0]["quantity"] = json!(2);
    mismatched["items"][0]["categoryAllocations"] = json!([
        { "categoryId": "food", "amount": money(600, "USD") },
        { "categoryId": "household", "amount": money(999, "USD") }
    ]);

    let mismatch_card = evaluate(mismatched);
    assert_eq!(outcome(&mismatch_card), "insufficient_data");
    assert!(mismatch_card["after"].is_null());

    let mut overflow = base_request();
    overflow["items"][0]["amount"] = money(i64::MAX, "USD");
    overflow["items"][0]["quantity"] = json!(2);

    let overflow_card = evaluate(overflow);
    assert_eq!(outcome(&overflow_card), "insufficient_data");
    assert!(overflow_card["after"].is_null());
}

#[test]
fn cart_adjustments_conserve_positive_child_charges_and_reject_excess_discount() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    set_item_amount(&mut input, 0, 1_600, "USD");
    input["items"][0]["categoryAllocations"] =
        json!([{ "categoryId": "food", "amount": money(1_600, "USD") }]);
    input["adjustments"] = json!([
        { "kind": "tax", "categoryId": "food", "amount": money(300, "USD") },
        { "kind": "fee", "categoryId": "food", "amount": money(200, "USD") },
        { "kind": "discount", "categoryId": "food", "amount": money(100, "USD") }
    ]);

    let card = evaluate(input);

    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(minor_units(&card["cart"]["subtotal"]), "1600");
    assert_eq!(minor_units(&card["cart"]["tax"]), "300");
    assert_eq!(minor_units(&card["cart"]["fee"]), "200");
    assert_eq!(minor_units(&card["cart"]["discount"]), "100");
    assert_eq!(minor_units(&card["cart"]["total"]), "2000");
    let category_charge = card["cart"]["categoryCharges"]
        .as_array()
        .expect("cart category charges must be an array")
        .iter()
        .find(|charge| charge["categoryId"] == "food")
        .expect("food category charge must be exposed");
    assert_eq!(minor_units(&category_charge["amount"]), "2000");
    let account_charge = card["cart"]["accountCharges"]
        .as_array()
        .expect("cart account charges must be an array")
        .iter()
        .find(|charge| charge["accountId"] == "checking")
        .expect("checking account charge must be exposed");
    assert_eq!(minor_units(&account_charge["amount"]), "2000");
    assert!(
        card["cart"]["categoryCharges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|charge| minor_units(&charge["amount"]).parse::<i64>().unwrap() > 0),
        "every net category child charge must be positive"
    );
    assert!(
        card["cart"]["accountCharges"]
            .as_array()
            .unwrap()
            .iter()
            .all(|charge| minor_units(&charge["amount"]).parse::<i64>().unwrap() > 0),
        "every account child charge must be positive"
    );

    let mut excess_discount = base_request();
    set_account_balance(&mut excess_discount, "checking", 30_000);
    set_category_availability(&mut excess_discount, "food", 5_000);
    set_item_amount(&mut excess_discount, 0, 1_000, "USD");
    excess_discount["items"][0]["categoryAllocations"] =
        json!([{ "categoryId": "food", "amount": money(1_000, "USD") }]);
    excess_discount["adjustments"] = json!([
        { "kind": "discount", "categoryId": "food", "amount": money(1_100, "USD") }
    ]);

    let blocked = evaluate(excess_discount);
    assert_eq!(outcome(&blocked), "insufficient_data");
    assert!(blocked["after"].is_null());
}
#[test]
fn fixed_tax_is_counted_once_when_two_items_share_a_category() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    set_item_amount(&mut input, 0, 1_000, "USD");
    let mut second = input["items"][0].clone();
    second["id"] = json!("second-food-item");
    input["items"].as_array_mut().unwrap().push(second);
    input["adjustments"] = json!([
        { "kind": "tax", "categoryId": "food", "amount": money(200, "USD") }
    ]);

    let card = evaluate(input);
    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(minor_units(&card["cart"]["total"]), "2200");
    assert_eq!(
        minor_units(&card["cart"]["accountCharges"][0]["amount"]),
        "2200"
    );
    assert_eq!(
        minor_units(&category_state(&card, "after", "food")["availability"]),
        "2800"
    );
    let checking = card["after"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["accountId"] == "checking")
        .unwrap();
    assert_eq!(minor_units(&checking["safeSpendingCapacity"]), "17800");
}

#[test]
fn shared_category_discount_spans_items_without_negative_line_charges() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    set_item_amount(&mut input, 0, 100, "USD");
    let mut second = input["items"][0].clone();
    second["id"] = json!("second-food-item");
    input["items"].as_array_mut().unwrap().push(second);
    input["adjustments"] = json!([
        { "kind": "discount", "categoryId": "food", "amount": money(150, "USD") }
    ]);

    let card = evaluate(input);
    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(minor_units(&card["cart"]["total"]), "50");
    assert_eq!(
        minor_units(&card["cart"]["categoryCharges"][0]["amount"]),
        "50"
    );
    assert_eq!(
        minor_units(&card["cart"]["accountCharges"][0]["amount"]),
        "50"
    );
    assert_eq!(
        minor_units(&category_state(&card, "after", "food")["availability"]),
        "4950"
    );
}

#[test]
fn cart_threshold_warnings_report_exact_excess_without_changing_safety_or_states() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    set_item_amount(&mut input, 0, 1_600, "USD");
    let baseline = evaluate(input.clone());

    input["warningThresholds"] = json!([
        {
            "id": "cart-limit",
            "basis": "cart_total",
            "maximum": money(1_500, "USD")
        },
        {
            "id": "food-limit",
            "basis": "category_charge",
            "categoryId": "food",
            "maximum": money(1_200, "USD")
        }
    ]);
    let warned = evaluate(input);

    assert_eq!(outcome(&warned), outcome(&baseline));
    assert_eq!(warned["before"], baseline["before"]);
    assert_eq!(warned["after"], baseline["after"]);
    let warnings = warned["warnings"]
        .as_array()
        .expect("threshold evaluation must expose warning entries");
    assert_eq!(warnings.len(), 2);
    let cart_warning = warnings
        .iter()
        .find(|warning| warning["thresholdId"] == "cart-limit")
        .expect("cart threshold warning must be exposed");
    assert_eq!(minor_units(&cart_warning["threshold"]), "1500");
    assert_eq!(minor_units(&cart_warning["actual"]), "1600");
    assert_eq!(minor_units(&cart_warning["excess"]), "100");
    let category_warning = warnings
        .iter()
        .find(|warning| warning["thresholdId"] == "food-limit")
        .expect("category threshold warning must be exposed");
    assert_eq!(minor_units(&category_warning["threshold"]), "1200");
    assert_eq!(minor_units(&category_warning["actual"]), "1600");
    assert_eq!(minor_units(&category_warning["excess"]), "400");
    assert!(cart_warning["alternatives"].is_array());
    assert!(category_warning["alternatives"].is_array());
}

#[test]
fn cart_trim_alternatives_drop_optional_before_planned_keep_fixed_fees_and_never_drop_required() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 10_000);

    let mut required = input["items"][0].clone();
    required["id"] = json!("required-item");
    required["amount"] = money(1_000, "USD");
    required["priority"] = json!("required");
    let mut planned = required.clone();
    planned["id"] = json!("planned-item");
    planned["priority"] = json!("planned");
    let mut optional = required.clone();
    optional["id"] = json!("optional-item");
    optional["priority"] = json!("optional");
    input["items"] = json!([required, planned, optional]);
    input["adjustments"] = json!([
        { "kind": "tax", "categoryId": "food", "amount": money(100, "USD") },
        { "kind": "fee", "categoryId": "food", "amount": money(50, "USD") }
    ]);
    input["warningThresholds"] = json!([{
        "id": "trim-limit",
        "basis": "cart_total",
        "maximum": money(1_150, "USD")
    }]);

    let card = evaluate(input);
    let alternatives = card["trimAlternatives"]
        .as_array()
        .expect("cart trim alternatives must be an array");
    let optional_removed = alternatives
        .iter()
        .find(|alternative| alternative["removedItemIds"] == json!(["optional-item"]))
        .expect("an optional-first alternative must be offered");
    assert_eq!(
        optional_removed["retainedItemIds"],
        json!(["required-item", "planned-item"])
    );
    assert_eq!(minor_units(&optional_removed["total"]), "2150");
    assert_eq!(
        minor_units(
            &optional_removed["categoryCharges"]
                .as_array()
                .unwrap()
                .iter()
                .find(|charge| charge["categoryId"] == "food")
                .unwrap()["amount"]
        ),
        "2150"
    );

    let planned_removed = alternatives
        .iter()
        .find(|alternative| {
            alternative["removedItemIds"] == json!(["optional-item", "planned-item"])
        })
        .expect("a planned-item alternative must retain the required item");
    assert_eq!(planned_removed["retainedItemIds"], json!(["required-item"]));
    assert_eq!(minor_units(&planned_removed["total"]), "1150");
    assert_eq!(
        minor_units(
            &planned_removed["categoryCharges"]
                .as_array()
                .unwrap()
                .iter()
                .find(|charge| charge["categoryId"] == "food")
                .unwrap()["amount"]
        ),
        "1150"
    );
    for alternative in alternatives {
        let removed = alternative["removedItemIds"]
            .as_array()
            .expect("trim alternative removed IDs must be an array");
        assert!(!removed.iter().any(|id| id == "required-item"));
        if removed.iter().any(|id| id == "planned-item") {
            assert!(removed.iter().any(|id| id == "optional-item"));
        }
    }

    let mut required_only = base_request();
    set_account_balance(&mut required_only, "checking", 30_000);
    set_category_availability(&mut required_only, "food", 10_000);
    set_item_amount(&mut required_only, 0, 3_000, "USD");
    required_only["items"][0]["priority"] = json!("required");
    required_only["adjustments"] = json!([
        { "kind": "tax", "categoryId": "food", "amount": money(100, "USD") },
        { "kind": "fee", "categoryId": "food", "amount": money(50, "USD") }
    ]);
    required_only["warningThresholds"] = json!([{
        "id": "required-limit",
        "basis": "cart_total",
        "maximum": money(1_000, "USD")
    }]);

    let required_card = evaluate(required_only);
    assert!(
        required_card["trimAlternatives"]
            .as_array()
            .expect("required-only trim alternatives must be an array")
            .is_empty(),
        "a required overage must not receive a falsely safe removal"
    );
}

#[test]
fn outside_price_requires_provenance_and_barcode_does_not_supply_an_amount() {
    let mut outside = base_request();
    set_account_balance(&mut outside, "checking", 30_000);
    set_category_availability(&mut outside, "food", 5_000);
    set_item_amount(&mut outside, 0, 800, "USD");
    outside["items"][0]["barcode"] = json!("barcode-0001");
    outside["items"][0]["priceProvenance"] = json!({
        "kind": "outside_price",
        "source": "retailer-feed",
        "store": "store-1",
        "observedAt": "2026-09-06T09:30:00Z",
        "estimate": true
    });

    let valid = evaluate(outside.clone());
    assert_eq!(outcome(&valid), "funded_now");
    assert_eq!(minor_units(&valid["cart"]["subtotal"]), "800");

    let mut missing_source = outside.clone();
    missing_source["items"][0]["priceProvenance"]["source"] = Value::Null;
    let missing_source_card = evaluate(missing_source);
    assert_eq!(outcome(&missing_source_card), "insufficient_data");
    assert!(missing_source_card["after"].is_null());

    let mut malformed_timestamp = outside.clone();
    malformed_timestamp["items"][0]["priceProvenance"]["observedAt"] =
        json!("not-a-canonical-time");
    let malformed_card = evaluate(malformed_timestamp);
    assert_eq!(outcome(&malformed_card), "insufficient_data");
    assert!(malformed_card["after"].is_null());

    let mut barcode_without_price = outside;
    barcode_without_price["items"][0]["amount"] = money(0, "USD");
    barcode_without_price["items"][0]["priceProvenance"] = json!({
        "kind": "current_session_manual",
        "observedAt": EVALUATED_AT,
        "estimate": false
    });
    let barcode_card = evaluate(barcode_without_price);
    assert_eq!(outcome(&barcode_card), "insufficient_data");
    assert!(barcode_card["after"].is_null());
}

#[test]
fn intent_hash_ignores_snapshot_observation_and_claim_revision_but_changes_on_cart_edit() {
    let mut original = base_request();
    set_account_balance(&mut original, "checking", 30_000);
    set_category_availability(&mut original, "food", 5_000);
    let first = evaluate(original.clone());
    assert_eq!(first["intentHash"].as_str().unwrap().len(), 64);

    let mut observed_again = original.clone();
    observed_again["financialSnapshot"]["capturedAt"] = json!("2026-09-06T10:30:00Z");
    observed_again["financialSnapshot"]["observations"][0]["observedAt"] =
        json!("2026-09-06T09:30:00Z");
    observed_again["claimSet"]["revision"] = json!("claims-2");
    let observed_card = evaluate(observed_again);
    assert_eq!(observed_card["intentHash"], first["intentHash"]);
    assert_ne!(observed_card["planHash"], first["planHash"]);

    let mut edited = original;
    edited["items"][0]["amount"] = money(2_100, "USD");
    let edited_card = evaluate(edited);
    assert_ne!(edited_card["intentHash"], first["intentHash"]);
}

#[test]
fn excluded_pending_activity_blocks_card_instead_of_claiming_available_cash() {
    let mut input = base_request();
    input["financialSnapshot"]["inclusionScope"]["pendingActivity"] = json!("excluded");
    let card = evaluate(input);
    assert_eq!(outcome(&card), "insufficient_data");
    assert!(card["after"].is_null());
    assert!(has_text(&card["blockers"], "pending_activity_excluded"));
}

#[test]
fn uncategorized_current_outflow_blocks_when_policy_requires_categorization() {
    let mut input = base_request();
    input["financialSnapshot"]["legacySnapshot"]["transactions"] = json!([{
        "id": "actual-uncategorized",
        "accountId": "checking",
        "date": "2026-09-06",
        "payeeId": null,
        "payeeName": "Grocer",
        "categoryId": null,
        "categoryName": null,
        "amount": money(-500, "USD"),
        "cleared": false,
        "reconciled": false,
        "importedId": "bank-uncategorized",
        "importedPayee": null,
        "notes": null,
        "tags": [],
        "transferAccountId": null,
        "subtransactions": []
    }]);
    input["context"]["policy"]["uncategorizedMode"] = json!("block");
    let card = evaluate(input);
    assert_eq!(outcome(&card), "insufficient_data");
    assert!(card["after"].is_null());
    assert!(has_text(&card["blockers"], "uncategorized"));
}

#[test]
fn obligation_projection_retains_exact_unknown_and_recurring_schedule_facts() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    set_item_amount(&mut input, 0, 500, "USD");
    input["financialSnapshot"]["liquidity"]["schedules"] = json!([
        {
            "id": "exact-recurring",
            "accountId": "checking",
            "categoryId": "food",
            "ruleId": null,
            "dueDate": "2026-09-20",
            "certainty": "exact",
            "amount": money(-1_200, "USD"),
            "minimum": null,
            "maximum": null,
            "recurrence": {
                "frequency": "monthly",
                "interval": 1,
                "patterns": [{ "kind": "day", "value": 20 }],
                "start": "2026-09-20",
                "endMode": "never",
                "endOccurrences": null,
                "endDate": null,
                "skipWeekend": false,
                "weekendSolveMode": null
            }
        },
        {
            "id": "unknown-one-time",
            "accountId": "savings",
            "categoryId": null,
            "ruleId": null,
            "dueDate": "2026-09-21",
            "certainty": "unknown",
            "amount": null,
            "minimum": null,
            "maximum": null,
            "recurrence": null
        },
        {
            "id": "exact-unmatched",
            "accountId": "savings",
            "categoryId": "food",
            "ruleId": null,
            "dueDate": "2026-09-22",
            "certainty": "exact",
            "amount": money(-600, "USD"),
            "minimum": null,
            "maximum": null,
            "recurrence": null
        },
        {
            "id": "at-horizon-end",
            "accountId": "checking",
            "categoryId": "food",
            "ruleId": null,
            "dueDate": "2026-10-01T00:00:00Z",
            "certainty": "exact",
            "amount": money(-900, "USD"),
            "minimum": null,
            "maximum": null,
            "recurrence": null
        }
    ]);
    let mut unmatched_recurring = input["financialSnapshot"]["liquidity"]["schedules"][0].clone();
    unmatched_recurring["id"] = json!("unmatched-recurring");
    unmatched_recurring["accountId"] = json!("savings");
    unmatched_recurring["categoryId"] = Value::Null;
    unmatched_recurring["dueDate"] = json!("2026-09-23");
    unmatched_recurring["recurrence"]["start"] = json!("2026-09-23");
    input["financialSnapshot"]["liquidity"]["schedules"]
        .as_array_mut()
        .unwrap()
        .push(unmatched_recurring);
    let mut undated_schedule = input["financialSnapshot"]["liquidity"]["schedules"][1].clone();
    undated_schedule["id"] = json!("undated-unknown");
    undated_schedule["dueDate"] = Value::Null;
    input["financialSnapshot"]["liquidity"]["schedules"]
        .as_array_mut()
        .unwrap()
        .push(undated_schedule);
    account_mut(&mut input, "checking")["obligations"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "exact-recurring",
            "economicObligationId": "schedule:exact-recurring:2026-09-20",
            "categoryId": "food",
            "amount": money(1_200, "USD"),
            "dueAt": "2026-09-20",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }));

    let card = evaluate(input);
    assert_eq!(outcome(&card), "funded_now");
    let before = card["before"]
        .as_object()
        .expect("unrelated schedule uncertainty still exposes a before projection");
    let food = category_state(&card, "before", "food");
    assert_eq!(minor_units(&food["commitments"]), "1200");
    let obligations = before["obligations"]
        .as_array()
        .expect("before state must retain normalized obligations");
    let exact = obligations
        .iter()
        .find(|value| value["scheduleId"] == "exact-recurring")
        .expect("matched account/schedule obligation must be retained");
    assert_eq!(exact["classification"], "commitment");
    assert_eq!(exact["accountId"], "checking");
    assert_eq!(exact["categoryId"], "food");
    assert_eq!(minor_units(&exact["amount"]), "1200");
    assert_eq!(exact["recurring"], true);
    assert_eq!(exact["recurrence"]["frequency"], "monthly");
    assert_eq!(exact["recurrence"]["interval"], 1);
    assert_eq!(exact["recurrence"]["patterns"][0]["kind"], "day");
    let unknown = obligations
        .iter()
        .find(|value| value["scheduleId"] == "unknown-one-time")
        .expect("an unaccounted schedule remains visible rather than disappearing");
    assert_eq!(unknown["classification"], "commitment");
    assert_eq!(unknown["accountId"], "savings");
    assert!(unknown["categoryId"].is_null());
    assert!(unknown["amount"].is_null());
    assert_eq!(unknown["amountState"], "unknown");
    assert_eq!(unknown["recurring"], false);
    let exact_unmatched = obligations
        .iter()
        .find(|value| value["scheduleId"] == "exact-unmatched")
        .expect("an exact schedule without an account obligation remains visible");
    assert_eq!(exact_unmatched["classification"], "commitment");
    assert_eq!(exact_unmatched["accountId"], "savings");
    assert_eq!(minor_units(&exact_unmatched["amount"]), "600");
    assert_eq!(exact_unmatched["amountState"], "known");
    assert_eq!(exact_unmatched["recurring"], false);
    let recurring_unmatched = obligations
        .iter()
        .find(|value| value["scheduleId"] == "unmatched-recurring")
        .expect("recurring schedule without an account obligation remains visible");
    assert_eq!(recurring_unmatched["accountId"], "savings");
    assert_eq!(recurring_unmatched["categoryId"], Value::Null);
    assert_eq!(minor_units(&recurring_unmatched["amount"]), "1200");
    assert_eq!(recurring_unmatched["recurring"], true);
    assert_eq!(recurring_unmatched["recurrence"]["frequency"], "monthly");
    assert!(!obligations
        .iter()
        .any(|value| value["scheduleId"] == "at-horizon-end"));
    assert!(!obligations
        .iter()
        .any(|value| value["scheduleId"] == "undated-unknown"));
}

#[test]
fn account_debit_claim_matching_preserves_commitment_and_account_scope() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    set_item_amount(&mut input, 0, 500, "USD");
    account_mut(&mut input, "checking")["obligations"] = json!([{
        "id": "bill",
        "economicObligationId": "bill",
        "categoryId": null,
        "amount": money(800, "USD"),
        "dueAt": "2026-09-20T12:00:00Z",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }]);
    input["claimSet"]["bundles"] = json!([{
        "id": "account-claims",
        "creationSnapshotId": SNAPSHOT_ID,
        "creationPolicyVersion": POLICY_VERSION,
        "state": "active",
        "expiresAt": VALID_UNTIL,
        "initiated": false,
        "effects": [
            {
                "kind": "account_debit",
                "resourceId": "checking",
                "amount": money(800, "USD"),
                "economicObligationId": "bill:account:checking",
                "sourceEconomicObligationId": "bill",
                "categoryId": null,
                "includedInBalance": false,
                "matchedTransactionIds": []
            },
            {
                "kind": "account_debit",
                "resourceId": "savings",
                "amount": money(300, "USD"),
                "economicObligationId": "savings-hold",
                "categoryId": null,
                "includedInBalance": false,
                "matchedTransactionIds": []
            }
        ]
    }]);

    let card = evaluate(input);
    assert_eq!(outcome(&card), "funded_now");
    let obligations = card["before"]["obligations"].as_array().unwrap();
    let bill = obligations
        .iter()
        .find(|value| value["economicObligationId"] == "bill")
        .expect("matching account claim must not replace its commitment");
    assert_eq!(bill["classification"], "commitment");
    assert_eq!(bill["accountId"], "checking");
    assert!(bill["categoryId"].is_null());
    assert_eq!(minor_units(&bill["amount"]), "800");
    let savings_hold = obligations
        .iter()
        .find(|value| value["economicObligationId"] == "savings-hold")
        .expect("unmatched account debit claim must be projected");
    assert_eq!(savings_hold["classification"], "reservation");
    assert_eq!(savings_hold["accountId"], "savings");
    assert!(savings_hold["categoryId"].is_null());
    assert_eq!(minor_units(&savings_hold["amount"]), "300");
}

#[test]
fn conflicting_account_and_category_obligation_identities_fail_closed() {
    let mut account_conflict = base_request();
    set_account_balance(&mut account_conflict, "checking", 30_000);
    set_category_availability(&mut account_conflict, "food", 5_000);
    account_mut(&mut account_conflict, "checking")["obligations"] = json!([
        {
            "id": "bill-a",
            "economicObligationId": "duplicate-bill",
            "categoryId": "food",
            "amount": money(1_000, "USD"),
            "dueAt": "2026-09-20T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        },
        {
            "id": "bill-b",
            "economicObligationId": "duplicate-bill",
            "categoryId": "food",
            "amount": money(1_001, "USD"),
            "dueAt": "2026-09-21T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }
    ]);
    let account_card = evaluate(account_conflict);
    assert_eq!(outcome(&account_card), "insufficient_data");
    assert!(account_card["after"].is_null());
    assert!(has_text(
        &account_card["blockers"],
        "ambiguous_obligation_match"
    ));

    let mut claim_conflict = base_request();
    set_account_balance(&mut claim_conflict, "checking", 30_000);
    set_category_availability(&mut claim_conflict, "food", 5_000);
    claim_conflict["claimSet"]["bundles"] = json!([
        {
            "id": "claim-a",
            "creationSnapshotId": SNAPSHOT_ID,
            "creationPolicyVersion": POLICY_VERSION,
            "state": "active",
            "expiresAt": VALID_UNTIL,
            "initiated": false,
            "effects": [{
                "kind": "category",
                "resourceId": "food",
                "amount": money(500, "USD"),
                "economicObligationId": "duplicate-reservation",
                "categoryId": "food",
                "includedInBalance": false,
                "matchedTransactionIds": []
            }]
        },
        {
            "id": "claim-b",
            "creationSnapshotId": SNAPSHOT_ID,
            "creationPolicyVersion": POLICY_VERSION,
            "state": "active",
            "expiresAt": VALID_UNTIL,
            "initiated": false,
            "effects": [{
                "kind": "category",
                "resourceId": "food",
                "amount": money(501, "USD"),
                "economicObligationId": "duplicate-reservation",
                "categoryId": "food",
                "includedInBalance": false,
                "matchedTransactionIds": []
            }]
        }
    ]);
    let claim_card = evaluate(claim_conflict);
    assert_eq!(outcome(&claim_card), "insufficient_data");
    assert!(claim_card["after"].is_null());
    assert!(has_text(&claim_card["blockers"], "ambiguous_claim_match"));
}

#[test]
fn purchase_time_boundaries_and_expiry_are_explicitly_fail_closed() {
    let mut at_now = base_request();
    set_account_balance(&mut at_now, "checking", 30_000);
    set_category_availability(&mut at_now, "food", 5_000);
    at_now["items"][0]["purchaseAt"] = json!(EVALUATED_AT);
    at_now["items"][0]["requiredBy"] = json!(EVALUATED_AT);
    let now_card = evaluate(at_now);
    assert_eq!(outcome(&now_card), "funded_now");
    assert_eq!(now_card["items"][0]["outcome"], "funded_now");

    let mut fractional = base_request();
    set_account_balance(&mut fractional, "checking", 30_000);
    set_category_availability(&mut fractional, "food", 5_000);
    fractional["items"][0]["purchaseAt"] = json!("2026-09-06T12:00:00.123456789Z");
    fractional["items"][0]["requiredBy"] = json!("2026-09-06T12:00:00.123456789Z");
    let fractional_card = evaluate(fractional);
    assert_eq!(outcome(&fractional_card), "funded_now");
    assert_eq!(fractional_card["items"][0]["amount"], money(2_000, "USD"));

    let mut at_horizon_end = base_request();
    set_account_balance(&mut at_horizon_end, "checking", 30_000);
    set_category_availability(&mut at_horizon_end, "food", 5_000);
    at_horizon_end["context"]["horizon"]["endsAt"] = json!("2026-09-07T00:00:00Z");
    at_horizon_end["items"][0]["purchaseAt"] = json!("2026-09-07T00:00:00Z");
    at_horizon_end["items"][0]["requiredBy"] = json!("2026-09-07T00:00:00Z");
    let end_card = evaluate(at_horizon_end);
    assert_eq!(outcome(&end_card), "insufficient_data");
    assert!(end_card["after"].is_null());
    assert!(has_text(&end_card["reasons"], "purchase_outside_horizon"));

    let mut required_after_purchase = base_request();
    set_account_balance(&mut required_after_purchase, "checking", 30_000);
    set_category_availability(&mut required_after_purchase, "food", 5_000);
    required_after_purchase["items"][0]["requiredBy"] = json!("2026-09-06T13:00:00Z");
    let required_card = evaluate(required_after_purchase);
    assert_eq!(outcome(&required_card), "insufficient_data");
    assert!(required_card["after"].is_null());
    assert!(has_text(
        &required_card["reasons"],
        "purchase_outside_horizon"
    ));

    let mut expired = base_request();
    set_account_balance(&mut expired, "checking", 30_000);
    set_category_availability(&mut expired, "food", 5_000);
    expired["validUntil"] = json!(EVALUATED_AT);
    let expired_card = evaluate(expired);
    assert_eq!(outcome(&expired_card), "insufficient_data");
    assert!(expired_card["after"].is_null());
    assert!(has_text(&expired_card["reasons"], "evaluation_expired"));
}

#[test]
fn date_obligation_horizon_and_calendar_validation_preserve_exact_boundaries() {
    let mut boundary = base_request();
    set_account_balance(&mut boundary, "checking", 30_000);
    set_category_availability(&mut boundary, "food", 5_000);
    account_mut(&mut boundary, "checking")["obligations"] = json!([
        {
            "id": "date-end",
            "economicObligationId": "date-end",
            "categoryId": "food",
            "amount": money(900, "USD"),
            "dueAt": "2026-10-01",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        },
        {
            "id": "timestamp-end",
            "economicObligationId": "timestamp-end",
            "categoryId": "food",
            "amount": money(700, "USD"),
            "dueAt": "2026-10-01T00:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }
    ]);
    let boundary_card = evaluate(boundary);
    assert_eq!(outcome(&boundary_card), "funded_now");
    assert_eq!(
        minor_units(&category_state(&boundary_card, "before", "food")["commitments"]),
        "900"
    );
    let boundary_obligations = boundary_card["before"]["obligations"].as_array().unwrap();
    assert!(boundary_obligations
        .iter()
        .any(|value| value["economicObligationId"] == "date-end"));
    assert!(!boundary_obligations
        .iter()
        .any(|value| value["economicObligationId"] == "timestamp-end"));

    let mut leap = base_request();
    set_account_balance(&mut leap, "checking", 30_000);
    set_category_availability(&mut leap, "food", 5_000);
    account_mut(&mut leap, "checking")["obligations"] = json!([{
        "id": "leap-day",
        "economicObligationId": "leap-day",
        "categoryId": null,
        "amount": money(100, "USD"),
        "dueAt": "2028-02-29",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }]);
    let leap_card = evaluate(leap);
    assert_eq!(outcome(&leap_card), "funded_now");
    assert!(!has_text(
        &leap_card["blockers"],
        "invalid_canonical_timestamp"
    ));

    let mut invalid_leap = base_request();
    set_account_balance(&mut invalid_leap, "checking", 30_000);
    invalid_leap["financialSnapshot"]["liquidity"]["accounts"][0]["obligations"] = json!([{
        "id": "invalid-leap",
        "economicObligationId": "invalid-leap",
        "categoryId": null,
        "amount": money(100, "USD"),
        "dueAt": "2027-02-29",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }]);
    let invalid_card = evaluate(invalid_leap);
    assert_eq!(outcome(&invalid_card), "insufficient_data");
    assert!(invalid_card["after"].is_null());
    assert!(has_text(
        &invalid_card["blockers"],
        "invalid_canonical_timestamp"
    ));
}

#[test]
fn coverage_and_material_observation_blockers_name_the_missing_trust_boundary() {
    for (field, blocker) in [
        ("accounts", "incomplete_accounts_coverage"),
        ("transactions", "incomplete_transactions_coverage"),
        ("categories", "incomplete_categories_coverage"),
        ("schedules", "incomplete_schedules_coverage"),
        ("budgets", "incomplete_budgets_coverage"),
    ] {
        let mut input = base_request();
        input["financialSnapshot"]["coverage"][field] = json!("partial");
        let card = evaluate(input);
        assert_eq!(outcome(&card), "insufficient_data", "{field} coverage");
        assert!(card["after"].is_null());
        assert!(has_text(&card["blockers"], blocker));
    }

    let mut explicit_empty_budget = base_request();
    explicit_empty_budget["financialSnapshot"]["coverage"]["budgets"] = json!("empty");
    let empty_budget_card = evaluate(explicit_empty_budget);
    assert!(!has_text(
        &empty_budget_card["blockers"],
        "incomplete_budgets_coverage"
    ));

    for (kind, state, blocker) in [
        (
            "duplicate_candidate",
            "present",
            "material_observation_duplicatecandidate",
        ),
        (
            "transfer_ambiguity",
            "ambiguous",
            "material_observation_transferambiguity",
        ),
        (
            "reconciliation",
            "unreconciled",
            "material_observation_reconciliation",
        ),
        (
            "currency_compatibility",
            "incompatible",
            "material_observation_currencycompatibility",
        ),
    ] {
        let mut input = base_request();
        input["financialSnapshot"]["observations"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "kind": kind,
                "scope": { "kind": "global" },
                "state": state,
                "observedAt": EVALUATED_AT,
                "evidence": []
            }));
        let card = evaluate(input);
        assert_eq!(outcome(&card), "insufficient_data", "{kind} observation");
        assert!(card["after"].is_null());
        assert!(has_text(&card["blockers"], blocker));
    }

    let mut uncleared = base_request();
    uncleared["financialSnapshot"]["inclusionScope"]["unclearedActivity"] = json!("excluded");
    let uncleared_card = evaluate(uncleared);
    assert_eq!(outcome(&uncleared_card), "insufficient_data");
    assert!(has_text(
        &uncleared_card["blockers"],
        "uncleared_activity_excluded"
    ));

    let mut split_uncategorized = base_request();
    split_uncategorized["financialSnapshot"]["legacySnapshot"]["transactions"] = json!([{
        "id": "split-outflow",
        "accountId": "checking",
        "date": "2026-09-06",
        "payeeId": null,
        "payeeName": "Market",
        "categoryId": "food",
        "categoryName": "Food",
        "amount": money(-500, "USD"),
        "cleared": false,
        "reconciled": false,
        "importedId": "bank-split",
        "importedPayee": null,
        "notes": null,
        "tags": [],
        "transferAccountId": null,
        "subtransactions": [{
            "id": "split-child",
            "accountId": "checking",
            "date": "2026-09-06",
            "payeeId": null,
            "payeeName": "Market",
            "categoryId": null,
            "categoryName": null,
            "amount": money(-500, "USD"),
            "cleared": false,
            "reconciled": false,
            "importedId": null,
            "importedPayee": null,
            "notes": null,
            "tags": [],
            "transferAccountId": null,
            "subtransactions": []
        }]
    }]);
    split_uncategorized["context"]["policy"]["uncategorizedMode"] = json!("block");
    let split_card = evaluate(split_uncategorized);
    assert_eq!(outcome(&split_card), "insufficient_data");
    assert!(has_text(
        &split_card["blockers"],
        "uncategorized_transaction_activity"
    ));
}

#[test]
fn category_and_account_evidence_currency_blockers_are_not_silently_normalized() {
    let mut category_currency = base_request();
    category_currency["financialSnapshot"]["liquidity"]["categories"][0]["availability"] =
        money(2_000, "EUR");
    let category_currency_card = evaluate(category_currency);
    assert_eq!(outcome(&category_currency_card), "insufficient_data");
    assert!(has_text(
        &category_currency_card["blockers"],
        "currency_mismatch:food"
    ));

    let mut policy_currency = base_request();
    category_policy_mut(&mut policy_currency, "food")["minimumRetained"] = money(100, "EUR");
    let policy_currency_card = evaluate(policy_currency);
    assert_eq!(outcome(&policy_currency_card), "insufficient_data");
    assert!(has_text(
        &policy_currency_card["blockers"],
        "currency_mismatch"
    ));

    let mut assumed_balance = base_request();
    account_mut(&mut assumed_balance, "checking")["balanceEvidence"]["source"] =
        json!("policy_assumption");
    let assumed_card = evaluate(assumed_balance);
    assert_eq!(outcome(&assumed_card), "insufficient_data");
    assert!(has_text(
        &assumed_card["blockers"],
        "account_checking_balance_evidence_known"
    ));

    let mut unknown_balance = base_request();
    account_mut(&mut unknown_balance, "checking")["balanceEvidence"]["state"] = json!("unknown");
    let unknown_card = evaluate(unknown_balance);
    assert_eq!(outcome(&unknown_card), "insufficient_data");
    assert!(has_text(
        &unknown_card["blockers"],
        "account_checking_balance_evidence_unknown"
    ));

    let mut future_category = base_request();
    category_mut(&mut future_category, "food")["evidence"]["observedAt"] =
        json!("2026-09-06T10:00:01Z");
    let future_card = evaluate(future_category);
    assert_eq!(outcome(&future_card), "insufficient_data");
    assert!(has_text(
        &future_card["blockers"],
        "category_food_evidence_future"
    ));
}

#[test]
fn duplicate_category_identity_policy_identity_and_period_errors_are_visible() {
    let mut duplicate_category = base_request();
    let duplicate = category_mut(&mut duplicate_category, "food").clone();
    duplicate_category["financialSnapshot"]["liquidity"]["categories"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let duplicate_card = evaluate(duplicate_category);
    assert_eq!(outcome(&duplicate_card), "insufficient_data");
    assert!(has_text(
        &duplicate_card["blockers"],
        "duplicate_or_invalid_category_identity"
    ));

    let mut duplicate_policy = base_request();
    let duplicate = category_policy_mut(&mut duplicate_policy, "food").clone();
    duplicate_policy["categoryPolicies"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let duplicate_policy_card = evaluate(duplicate_policy);
    assert_eq!(outcome(&duplicate_policy_card), "insufficient_data");
    assert!(has_text(
        &duplicate_policy_card["blockers"],
        "duplicate_or_invalid_category_policy"
    ));

    let mut period_mismatch = base_request();
    add_category(&mut period_mismatch, "reserve", 1_000);
    category_mut(&mut period_mismatch, "reserve")["asOfMonth"] = json!("2026-08");
    category_mut(&mut period_mismatch, "reserve")["periodKind"] = json!("current");
    let period_card = evaluate(period_mismatch);
    assert_eq!(outcome(&period_card), "insufficient_data");
    assert!(has_text(
        &period_card["blockers"],
        "category_period_mismatch"
    ));

    let mut invalid_month = base_request();
    add_category(&mut invalid_month, "reserve", 1_000);
    category_mut(&mut invalid_month, "reserve")["asOfMonth"] = json!("2026-13");
    let month_card = evaluate(invalid_month);
    assert_eq!(outcome(&month_card), "insufficient_data");
    assert!(has_text(&month_card["blockers"], "invalid_as_of_month"));

    let mut negative_category = base_request();
    set_category_availability(&mut negative_category, "food", -1);
    let negative_card = evaluate(negative_category);
    assert_eq!(outcome(&negative_card), "insufficient_data");
    assert!(has_text(
        &negative_card["blockers"],
        "negative_category_availability"
    ));

    let mut missing_obligation_id = base_request();
    account_mut(&mut missing_obligation_id, "checking")["obligations"] = json!([{
        "id": "missing-economic-id",
        "economicObligationId": "",
        "categoryId": "food",
        "amount": money(100, "USD"),
        "dueAt": "2026-09-20T12:00:00Z",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }]);
    let missing_id_card = evaluate(missing_obligation_id);
    assert_eq!(outcome(&missing_id_card), "insufficient_data");
    assert!(has_text(
        &missing_id_card["blockers"],
        "missing_economic_obligation_id"
    ));
}

#[test]
fn price_provenance_and_route_fallbacks_remain_checked_and_traceable() {
    let mut blank_barcode = base_request();
    set_account_balance(&mut blank_barcode, "checking", 30_000);
    blank_barcode["items"][0]["barcode"] = json!(" ");
    let blank_card = evaluate(blank_barcode);
    assert_eq!(outcome(&blank_card), "insufficient_data");
    assert!(has_text(&blank_card["blockers"], "invalid_barcode"));

    let mut invalid_kind = base_request();
    set_account_balance(&mut invalid_kind, "checking", 30_000);
    invalid_kind["items"][0]["priceProvenance"] = json!({
        "kind": "untrusted_feed",
        "source": "retailer-feed",
        "store": "store-1",
        "observedAt": EVALUATED_AT,
        "estimate": true
    });
    let invalid_kind_card = evaluate(invalid_kind);
    assert_eq!(outcome(&invalid_kind_card), "insufficient_data");
    assert!(has_text(
        &invalid_kind_card["blockers"],
        "invalid_price_provenance_kind"
    ));

    for (selection, source) in [
        (
            json!({
                "explicitAccountId": null,
                "sessionAccountId": null,
                "approvedPreference": {
                    "accountId": "checking",
                    "referenceId": "approved-route-1"
                },
                "historicalRoute": null
            }),
            "approved_preference",
        ),
        (
            json!({
                "explicitAccountId": null,
                "sessionAccountId": null,
                "approvedPreference": null,
                "historicalRoute": {
                    "accountId": "checking",
                    "referenceId": "history-route-1"
                }
            }),
            "historical_route",
        ),
    ] {
        let mut input = base_request();
        set_account_balance(&mut input, "checking", 30_000);
        set_category_availability(&mut input, "food", 5_000);
        input["items"][0]["routeSelection"] = selection;
        input["adjustments"] = json!([
            { "kind": "tax", "categoryId": "food", "amount": money(100, "USD") }
        ]);
        let card = evaluate(input);
        assert_eq!(outcome(&card), "funded_now");
        assert_eq!(card["selectedAccountId"], "checking");
        assert_eq!(card["selectionSource"], source);
        assert_eq!(card["items"][0]["selectionSource"], source);
        assert_eq!(minor_units(&card["cart"]["total"]), "2100");
    }
}

#[test]
fn cart_projection_rejects_currency_allocations_adjustments_and_thresholds() {
    let mut mixed_currency = base_request();
    set_account_balance(&mut mixed_currency, "checking", 30_000);
    set_category_availability(&mut mixed_currency, "food", 5_000);
    let mut second = mixed_currency["items"][0].clone();
    second["id"] = json!("eur-item");
    second["amount"] = money(100, "EUR");
    mixed_currency["items"].as_array_mut().unwrap().push(second);
    let mixed_card = evaluate(mixed_currency);
    assert_eq!(outcome(&mixed_card), "insufficient_data");
    assert!(mixed_card["after"].is_null());
    assert!(has_text(&mixed_card["blockers"], "currency_mismatch"));

    let mut empty_allocations = base_request();
    set_account_balance(&mut empty_allocations, "checking", 30_000);
    empty_allocations["items"][0]["categoryAllocations"] = json!([]);
    let empty_card = evaluate(empty_allocations);
    assert_eq!(outcome(&empty_card), "insufficient_data");
    assert!(empty_card["after"].is_null());
    assert!(has_text(
        &empty_card["blockers"],
        "invalid_category_allocation"
    ));

    let mut zero_allocation = base_request();
    set_account_balance(&mut zero_allocation, "checking", 30_000);
    zero_allocation["items"][0]["categoryAllocations"] =
        json!([{ "categoryId": "food", "amount": money(0, "USD") }]);
    let zero_card = evaluate(zero_allocation);
    assert_eq!(outcome(&zero_card), "insufficient_data");
    assert!(zero_card["after"].is_null());
    assert!(has_text(
        &zero_card["blockers"],
        "invalid_category_allocation"
    ));

    let mut invalid_adjustment_kind = base_request();
    set_account_balance(&mut invalid_adjustment_kind, "checking", 30_000);
    invalid_adjustment_kind["adjustments"] = json!([{
        "kind": "coupon",
        "categoryId": "food",
        "amount": money(100, "USD")
    }]);
    let kind_card = evaluate(invalid_adjustment_kind);
    assert_eq!(outcome(&kind_card), "insufficient_data");
    assert!(kind_card["after"].is_null());
    assert!(has_text(
        &kind_card["blockers"],
        "invalid_cart_adjustment_kind"
    ));

    let mut missing_cart_category = base_request();
    set_account_balance(&mut missing_cart_category, "checking", 30_000);
    add_category(&mut missing_cart_category, "reserve", 1_000);
    add_category_policy(
        &mut missing_cart_category,
        "reserve",
        "ordinary",
        false,
        0,
        0,
    );
    missing_cart_category["adjustments"] = json!([{
        "kind": "tax",
        "categoryId": "reserve",
        "amount": money(100, "USD")
    }]);
    let missing_cart_card = evaluate(missing_cart_category);
    assert_eq!(outcome(&missing_cart_card), "insufficient_data");
    assert!(missing_cart_card["after"].is_null());
    assert!(has_text(
        &missing_cart_card["blockers"],
        "adjustment_category_missing_from_cart"
    ));

    let mut adjustment_currency = base_request();
    set_account_balance(&mut adjustment_currency, "checking", 30_000);
    add_category(&mut adjustment_currency, "reserve", 1_000);
    adjustment_currency["financialSnapshot"]["liquidity"]["categories"][1]["availability"] =
        money(1_000, "EUR");
    adjustment_currency["categoryPolicies"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "categoryId": "reserve",
            "kind": "ordinary",
            "donorEligible": false,
            "minimumRetained": money(0, "EUR"),
            "projectedRemainingNeed": money(0, "EUR")
        }));
    adjustment_currency["adjustments"] = json!([{
        "kind": "tax",
        "categoryId": "reserve",
        "amount": money(100, "USD")
    }]);
    let adjustment_currency_card = evaluate(adjustment_currency);
    assert_eq!(outcome(&adjustment_currency_card), "insufficient_data");
    assert!(adjustment_currency_card["after"].is_null());
    assert!(has_text(
        &adjustment_currency_card["blockers"],
        "currency_mismatch"
    ));

    let mut invalid_threshold = base_request();
    set_account_balance(&mut invalid_threshold, "checking", 30_000);
    invalid_threshold["warningThresholds"] = json!([{
        "id": "bad-basis",
        "basis": "line_total",
        "categoryId": null,
        "maximum": money(100, "USD")
    }]);
    let threshold_card = evaluate(invalid_threshold);
    assert_eq!(outcome(&threshold_card), "insufficient_data");
    assert!(threshold_card["after"].is_null());
    assert!(has_text(
        &threshold_card["blockers"],
        "invalid_warning_threshold"
    ));

    let mut missing_threshold_category = base_request();
    set_account_balance(&mut missing_threshold_category, "checking", 30_000);
    missing_threshold_category["warningThresholds"] = json!([{
        "id": "missing-category",
        "basis": "category_charge",
        "categoryId": "reserve",
        "maximum": money(100, "USD")
    }]);
    let missing_threshold_card = evaluate(missing_threshold_category);
    assert_eq!(outcome(&missing_threshold_card), "insufficient_data");
    assert!(missing_threshold_card["after"].is_null());
    assert!(has_text(
        &missing_threshold_card["blockers"],
        "category_missing"
    ));
}

#[test]
fn multiple_current_donors_report_exact_reallocation_paths_and_after_states() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 0);
    add_category(&mut input, "reserve-a", 5_000);
    add_category(&mut input, "reserve-b", 4_000);
    add_category_policy(&mut input, "reserve-a", "ordinary", true, 1_000, 0);
    add_category_policy(&mut input, "reserve-b", "ordinary", true, 1_000, 0);
    set_item_amount(&mut input, 0, 7_000, "USD");

    let card = evaluate(input);
    assert_eq!(outcome(&card), "safe_with_reallocation");
    let paths: Vec<&Value> = card["fundingPaths"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|path| path["kind"] == "category_reallocation")
        .collect();
    assert_eq!(paths.len(), 2);
    let first = paths
        .iter()
        .find(|path| path["sourceCategoryId"] == "reserve-a")
        .unwrap();
    assert_eq!(minor_units(&first["amount"]), "4000");
    assert_eq!(minor_units(&first["before"]["sourceAvailability"]), "5000");
    assert_eq!(minor_units(&first["after"]["sourceAvailability"]), "1000");
    let second = paths
        .iter()
        .find(|path| path["sourceCategoryId"] == "reserve-b")
        .unwrap();
    assert_eq!(minor_units(&second["amount"]), "3000");
    assert_eq!(minor_units(&second["before"]["sourceAvailability"]), "4000");
    assert_eq!(minor_units(&second["after"]["sourceAvailability"]), "1000");
    assert_eq!(
        minor_units(&category_state(&card, "after", "reserve-a")["availability"]),
        "1000"
    );
    assert_eq!(
        minor_units(&category_state(&card, "after", "reserve-b")["availability"]),
        "1000"
    );
    assert_eq!(
        minor_units(&category_state(&card, "after", "food")["availability"]),
        "0"
    );
    assert!(card["authorizationRequirements"]
        .as_array()
        .unwrap()
        .iter()
        .any(|value| value == "category_reallocation_approval"));
}

#[test]
fn request_timestamp_validation_rejects_invalid_nested_financial_facts() {
    let assert_invalid = |input: Value| {
        let card = evaluate(input);
        assert_eq!(outcome(&card), "insufficient_data");
        assert!(card["after"].is_null());
        assert!(has_text(&card["blockers"], "invalid_canonical_timestamp"));
    };

    let mut captured = base_request();
    captured["financialSnapshot"]["capturedAt"] = json!("not-a-time");
    assert_invalid(captured);

    let mut observation = base_request();
    observation["financialSnapshot"]["observations"][0]["observedAt"] = json!("not-a-time");
    assert_invalid(observation);

    let mut evaluated = base_request();
    evaluated["context"]["evaluatedAt"] = json!("not-a-time");
    assert_invalid(evaluated);

    let mut horizon_start = base_request();
    horizon_start["context"]["horizon"]["startsAt"] = json!("not-a-time");
    assert_invalid(horizon_start);

    let mut horizon_end = base_request();
    horizon_end["context"]["horizon"]["endsAt"] = json!("not-a-time");
    assert_invalid(horizon_end);

    let mut valid_until = base_request();
    valid_until["validUntil"] = json!("not-a-time");
    assert_invalid(valid_until);

    let mut policy_expiry = base_request();
    policy_expiry["liquidityPolicy"]["expiresAt"] = json!("not-a-time");
    assert_invalid(policy_expiry);

    let mut purchase = base_request();
    purchase["items"][0]["purchaseAt"] = json!("not-a-time");
    assert_invalid(purchase);

    let mut required_by = base_request();
    required_by["items"][0]["requiredBy"] = json!("not-a-time");
    assert_invalid(required_by);

    let mut provenance = base_request();
    provenance["items"][0]["priceProvenance"] = json!({
        "kind": "current_session_manual",
        "source": null,
        "store": null,
        "observedAt": "not-a-time",
        "estimate": false
    });
    assert_invalid(provenance);

    let mut provider_arrival = base_request();
    provider_arrival["liquidityPolicy"]["transferRoutes"][0]["providerArrivalAt"] =
        json!("not-a-time");
    assert_invalid(provider_arrival);

    let mut route_evidence = base_request();
    route_evidence["liquidityPolicy"]["transferRoutes"][0]["evidence"]["observedAt"] =
        json!("not-a-time");
    assert_invalid(route_evidence);

    let mut holiday = base_request();
    holiday["liquidityPolicy"]["transferRoutes"][0]["holidays"] = json!(["not-a-date"]);
    assert_invalid(holiday);

    let mut claim_expiry = base_request();
    add_claim(
        &mut claim_expiry,
        "invalid-expiry",
        "food",
        100,
        "not-a-time",
    );
    assert_invalid(claim_expiry);

    let mut category_evidence = base_request();
    category_mut(&mut category_evidence, "food")["evidence"]["expiresAt"] = json!("not-a-time");
    assert_invalid(category_evidence);

    for field in [
        "balanceEvidence",
        "activityEvidence",
        "scheduleEvidence",
        "freshnessEvidence",
        "currencyEvidence",
        "kindEvidence",
        "ownershipEvidence",
        "holdsEvidence",
    ] {
        let mut account_evidence = base_request();
        account_mut(&mut account_evidence, "checking")[field]["expiresAt"] = json!("not-a-time");
        assert_invalid(account_evidence);
    }

    let mut obligation_due = base_request();
    account_mut(&mut obligation_due, "checking")["obligations"] = json!([{
        "id": "invalid-due",
        "economicObligationId": "invalid-due",
        "categoryId": "food",
        "amount": money(100, "USD"),
        "dueAt": "not-a-time",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }]);
    assert_invalid(obligation_due);

    let mut schedule_due = base_request();
    schedule_due["financialSnapshot"]["liquidity"]["schedules"] = json!([{
        "id": "invalid-schedule-date",
        "accountId": "checking",
        "categoryId": "food",
        "ruleId": null,
        "dueDate": "not-a-date",
        "certainty": "unknown",
        "amount": null,
        "minimum": null,
        "maximum": null,
        "recurrence": null
    }]);
    assert_invalid(schedule_due);
}

#[test]
fn obligation_projection_filters_settled_facts_and_rejects_claim_scope_conflicts() {
    let mut filtered = base_request();
    set_account_balance(&mut filtered, "checking", 30_000);
    set_category_availability(&mut filtered, "food", 5_000);
    account_mut(&mut filtered, "checking")["obligations"] = json!([
        {
            "id": "active",
            "economicObligationId": "active",
            "categoryId": "food",
            "amount": money(400, "USD"),
            "dueAt": "2026-09-20T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        },
        {
            "id": "paid",
            "economicObligationId": "paid",
            "categoryId": "food",
            "amount": money(500, "USD"),
            "dueAt": "2026-09-20T12:00:00Z",
            "paid": true,
            "includedInBalance": false,
            "matchedTransactionIds": []
        },
        {
            "id": "included",
            "economicObligationId": "included",
            "categoryId": "food",
            "amount": money(600, "USD"),
            "dueAt": "2026-09-20T12:00:00Z",
            "paid": false,
            "includedInBalance": true,
            "matchedTransactionIds": []
        },
        {
            "id": "outside",
            "economicObligationId": "outside",
            "categoryId": "food",
            "amount": money(700, "USD"),
            "dueAt": "2026-10-01T00:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }
    ]);
    let filtered_card = evaluate(filtered);
    assert_eq!(outcome(&filtered_card), "funded_now");
    assert_eq!(
        minor_units(&category_state(&filtered_card, "before", "food")["commitments"]),
        "400"
    );
    let filtered_obligations = filtered_card["before"]["obligations"].as_array().unwrap();
    assert_eq!(filtered_obligations.len(), 1);
    assert_eq!(filtered_obligations[0]["economicObligationId"], "active");

    let mut duplicate_same = base_request();
    set_account_balance(&mut duplicate_same, "checking", 30_000);
    set_category_availability(&mut duplicate_same, "food", 5_000);
    account_mut(&mut duplicate_same, "checking")["obligations"] = json!([
        {
            "id": "same-a",
            "economicObligationId": "same",
            "categoryId": "food",
            "amount": money(400, "USD"),
            "dueAt": "2026-09-20T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        },
        {
            "id": "same-b",
            "economicObligationId": "same",
            "categoryId": "food",
            "amount": money(400, "USD"),
            "dueAt": "2026-09-21T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }
    ]);
    let duplicate_card = evaluate(duplicate_same);
    assert_eq!(outcome(&duplicate_card), "funded_now");
    assert_eq!(
        minor_units(&category_state(&duplicate_card, "before", "food")["commitments"]),
        "400"
    );
    assert_eq!(
        duplicate_card["before"]["obligations"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let mut claim_projection = base_request();
    set_account_balance(&mut claim_projection, "checking", 30_000);
    set_category_availability(&mut claim_projection, "food", 5_000);
    claim_projection["claimSet"]["bundles"] = json!([
        {
            "id": "claim-projection",
            "creationSnapshotId": SNAPSHOT_ID,
            "creationPolicyVersion": POLICY_VERSION,
            "state": "active",
            "expiresAt": VALID_UNTIL,
            "initiated": false,
            "effects": [
                {
                    "kind": "category",
                    "resourceId": "food",
                    "amount": money(300, "USD"),
                    "economicObligationId": "category-reserve",
                    "categoryId": null,
                    "includedInBalance": false,
                    "matchedTransactionIds": []
                },
                {
                    "kind": "category",
                    "resourceId": "food",
                    "amount": money(200, "USD"),
                    "economicObligationId": "already-in-balance",
                    "categoryId": "food",
                    "includedInBalance": true,
                    "matchedTransactionIds": []
                }
            ]
        }
    ]);
    let claim_card = evaluate(claim_projection);
    assert_eq!(outcome(&claim_card), "funded_now");
    assert_eq!(
        minor_units(&category_state(&claim_card, "before", "food")["reservations"]),
        "300"
    );
    let category_reservation = claim_card["before"]["obligations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|value| value["economicObligationId"] == "category-reserve")
        .unwrap();
    assert_eq!(category_reservation["classification"], "reservation");
    assert_eq!(category_reservation["categoryId"], "food");
    assert!(claim_card["before"]["obligations"]
        .as_array()
        .unwrap()
        .iter()
        .all(|value| value["economicObligationId"] != "already-in-balance"));

    let mut negative_claim = base_request();
    negative_claim["claimSet"]["bundles"] = json!([{
        "id": "negative-claim",
        "creationSnapshotId": SNAPSHOT_ID,
        "creationPolicyVersion": POLICY_VERSION,
        "state": "active",
        "expiresAt": VALID_UNTIL,
        "initiated": false,
        "effects": [{
            "kind": "category",
            "resourceId": "food",
            "amount": money(-1, "USD"),
            "economicObligationId": "negative-claim",
            "categoryId": "food",
            "includedInBalance": false,
            "matchedTransactionIds": []
        }]
    }]);
    let negative_claim_card = evaluate(negative_claim);
    assert_eq!(outcome(&negative_claim_card), "insufficient_data");
    assert!(has_text(&negative_claim_card["blockers"], "negative_claim"));

    let mut currency_obligation = base_request();
    account_mut(&mut currency_obligation, "checking")["obligations"] = json!([{
        "id": "eur-obligation",
        "economicObligationId": "eur-obligation",
        "categoryId": "food",
        "amount": money(100, "EUR"),
        "dueAt": "2026-09-20T12:00:00Z",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }]);
    let currency_obligation_card = evaluate(currency_obligation);
    assert_eq!(outcome(&currency_obligation_card), "insufficient_data");
    assert!(has_text(
        &currency_obligation_card["blockers"],
        "currency_mismatch"
    ));

    let mut category_scope = base_request();
    category_scope["claimSet"]["bundles"] = json!([{
        "id": "scope-conflict",
        "creationSnapshotId": SNAPSHOT_ID,
        "creationPolicyVersion": POLICY_VERSION,
        "state": "active",
        "expiresAt": VALID_UNTIL,
        "initiated": false,
        "effects": [{
            "kind": "category",
            "resourceId": "food",
            "amount": money(100, "USD"),
            "economicObligationId": "scope-conflict",
            "categoryId": "reserve",
            "includedInBalance": false,
            "matchedTransactionIds": []
        }]
    }]);
    let scope_card = evaluate(category_scope);
    assert_eq!(outcome(&scope_card), "insufficient_data");
    assert!(has_text(&scope_card["blockers"], "ambiguous_claim_match"));

    let mut malformed_source = base_request();
    malformed_source["claimSet"]["bundles"] = json!([{
        "id": "malformed-source",
        "creationSnapshotId": SNAPSHOT_ID,
        "creationPolicyVersion": POLICY_VERSION,
        "state": "active",
        "expiresAt": VALID_UNTIL,
        "initiated": false,
        "effects": [{
            "kind": "category",
            "resourceId": "food",
            "amount": money(100, "USD"),
            "economicObligationId": "wrong:category:food",
            "sourceEconomicObligationId": "source",
            "categoryId": "food",
            "includedInBalance": false,
            "matchedTransactionIds": []
        }]
    }]);
    let malformed_card = evaluate(malformed_source);
    assert_eq!(outcome(&malformed_card), "insufficient_data");
    assert!(has_text(
        &malformed_card["blockers"],
        "ambiguous_claim_match"
    ));

    let mut account_claim_conflict = base_request();
    set_account_balance(&mut account_claim_conflict, "checking", 30_000);
    account_mut(&mut account_claim_conflict, "checking")["obligations"] = json!([{
        "id": "account-bill",
        "economicObligationId": "account-bill",
        "categoryId": null,
        "amount": money(800, "USD"),
        "dueAt": "2026-09-20T12:00:00Z",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }]);
    account_claim_conflict["claimSet"]["bundles"] = json!([{
        "id": "account-bill-claim",
        "creationSnapshotId": SNAPSHOT_ID,
        "creationPolicyVersion": POLICY_VERSION,
        "state": "active",
        "expiresAt": VALID_UNTIL,
        "initiated": false,
        "effects": [{
            "kind": "account_debit",
            "resourceId": "checking",
            "amount": money(801, "USD"),
            "economicObligationId": "account-bill:account:checking",
            "sourceEconomicObligationId": "account-bill",
            "categoryId": null,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }]
    }]);
    let account_claim_card = evaluate(account_claim_conflict);
    assert_eq!(outcome(&account_claim_card), "insufficient_data");
    assert!(has_text(
        &account_claim_card["blockers"],
        "ambiguous_claim_match"
    ));
}

#[test]
fn repeated_category_claim_and_multiple_discounts_are_counted_once_and_exactly() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    add_claim(&mut input, "reserved-food", "food", 1_000, VALID_UNTIL);
    let mut duplicate = input["claimSet"]["bundles"][0].clone();
    duplicate["id"] = json!("same-obligation-second-claim");
    input["claimSet"]["bundles"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    input["adjustments"] = json!([
        { "kind": "discount", "categoryId": "food", "amount": money(100, "USD") },
        { "kind": "discount", "categoryId": "food", "amount": money(200, "USD") }
    ]);
    let card = evaluate(input);
    assert_eq!(outcome(&card), "funded_now");
    assert_eq!(
        minor_units(&category_state(&card, "before", "food")["reservations"]),
        "1000"
    );
    assert_eq!(minor_units(&card["cart"]["discount"]), "300");
    assert_eq!(minor_units(&card["cart"]["total"]), "1700");
    assert_eq!(
        minor_units(&category_state(&card, "after", "food")["availability"]),
        "3300"
    );
}

#[test]
fn credit_payment_evidence_and_dates_are_material_even_with_otherwise_ready_cash() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    let mut evidence = account_mut(&mut input, "checking")["balanceEvidence"].clone();
    evidence["state"] = json!("unknown");
    account_mut(&mut input, "checking")["credit"] = json!({
        "authorizationAvailable": money(5_000, "USD"),
        "pendingIncludedInAuthorization": true,
        "paymentAccountId": "savings",
        "paymentCategoryId": "food",
        "dueAt": "2026-09-20T12:00:00Z",
        "reservedCash": money(1_000, "USD"),
        "economicObligationId": "credit-payment",
        "evidence": evidence
    });
    let blocked = evaluate(input.clone());
    assert_eq!(outcome(&blocked), "insufficient_data");
    assert!(has_text(
        &blocked["blockers"],
        "account_checking_credit_evidence_unknown"
    ));

    account_mut(&mut input, "checking")["credit"]["dueAt"] = json!("2026-02-30");
    let invalid = evaluate(input.clone());
    assert_eq!(outcome(&invalid), "insufficient_data");
    assert!(has_text(
        &invalid["blockers"],
        "invalid_canonical_timestamp"
    ));
    for malformed_due_at in [
        "20x6-09-20T12:00:00Z",
        "2026-0x-20T12:00:00Z",
        "2026-09-2xT12:00:00Z",
        "2026-09-20T1x:00:00Z",
        "2026-09-20T12:0x:00Z",
        "2026-09-20T12:00:0xZ",
    ] {
        account_mut(&mut input, "checking")["credit"]["dueAt"] = json!(malformed_due_at);
        let invalid = evaluate(input.clone());
        assert_eq!(outcome(&invalid), "insufficient_data");
        assert!(has_text(
            &invalid["blockers"],
            "invalid_canonical_timestamp"
        ));
    }
}

#[test]
fn unknown_purchase_category_blocks_without_discarding_a_missing_category_warning() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    input["items"][0]["categoryId"] = json!("deleted-category");
    let card = evaluate(input);
    assert_eq!(outcome(&card), "insufficient_data");
    assert!(card["after"].is_null());
    assert!(has_text(
        &card["blockers"],
        "category_missing:deleted-category"
    ));
}

#[test]
fn orphaned_category_obligation_blocks_instead_of_ignoring_the_commitment() {
    let mut input = base_request();
    set_account_balance(&mut input, "checking", 30_000);
    set_category_availability(&mut input, "food", 5_000);
    account_mut(&mut input, "checking")["obligations"] = json!([{
        "id": "orphaned-bill",
        "economicObligationId": "orphaned-bill",
        "categoryId": "deleted-category",
        "amount": money(800, "USD"),
        "dueAt": "2026-09-20T12:00:00Z",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }]);
    let card = evaluate(input);
    assert_eq!(outcome(&card), "insufficient_data");
    assert!(card["after"].is_null());
    assert!(has_text(&card["blockers"], "category_missing"));
}

#[test]
fn malformed_account_obligations_never_turn_into_spendable_balance() {
    for (economic_id, amount, expected_blocker) in [
        ("", 800, "missing_economic_obligation_id"),
        ("negative-bill", -800, "negative_obligation"),
    ] {
        let mut input = base_request();
        set_account_balance(&mut input, "checking", 30_000);
        set_category_availability(&mut input, "food", 5_000);
        account_mut(&mut input, "checking")["obligations"] = json!([{
            "id": "invalid-bill",
            "economicObligationId": economic_id,
            "categoryId": "food",
            "amount": money(amount, "USD"),
            "dueAt": "2026-09-20T12:00:00Z",
            "paid": false,
            "includedInBalance": false,
            "matchedTransactionIds": []
        }]);
        let card = evaluate(input);
        assert_eq!(outcome(&card), "insufficient_data");
        assert!(card["after"].is_null());
        assert!(has_text(&card["blockers"], expected_blocker));
    }
}
