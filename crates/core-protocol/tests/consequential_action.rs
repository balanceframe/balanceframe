use balanceframe_core_protocol::{
    plan_consequential_action, verify_consequential_action, PlanConsequentialActionRequest,
    VerifyConsequentialActionRequest,
};
use serde_json::{json, Value};

const LIQUIDITY_FIXTURE: &str =
    include_str!("../../../protocol/fixtures/account-aware-liquidity.json");
const FOUNDATION_FIXTURE: &str =
    include_str!("../../../protocol/fixtures/financial-decision-foundation.json");
const ACTION_FIXTURE: &str = include_str!("../../../protocol/fixtures/consequential-action.json");
const EVALUATED_AT: &str = "2026-09-06T10:00:00Z";
const PURCHASE_AT: &str = "2026-09-06T12:00:00Z";

fn fixture(input: &str) -> Value {
    serde_json::from_str(input).expect("canonical fixture must be valid JSON")
}

fn money(minor_units: impl ToString, currency: &str) -> Value {
    json!({"minorUnits": minor_units.to_string(), "currency": currency})
}

fn canonical_decision_card_request() -> Value {
    let liquidity = fixture(LIQUIDITY_FIXTURE);
    let foundation = fixture(FOUNDATION_FIXTURE);
    let mut snapshot = foundation["full"].clone();
    snapshot["snapshotId"] = liquidity["snapshotId"].clone();
    snapshot["contentHash"] = liquidity["contentHash"].clone();
    snapshot["capturedAt"] = json!(EVALUATED_AT);
    snapshot["liquidity"] = liquidity["facts"].clone();
    snapshot["observations"] = json!([{
        "kind": "account_freshness",
        "scope": {"kind": "account", "id": "checking"},
        "state": "fresh",
        "observedAt": EVALUATED_AT,
        "evidence": [{"evidenceId": "checking-freshness", "kind": "bank_sync", "authorized": true, "redaction": "visible"}]
    }]);
    snapshot["observations"]
        .as_array_mut()
        .expect("source observations are an array")
        .push(fixture(ACTION_FIXTURE)["sourceObservation"].clone());
    for collection in [
        "accounts",
        "transactions",
        "categories",
        "budgets",
        "schedules",
    ] {
        snapshot["legacySnapshot"][collection] = json!([]);
    }
    for collection in [
        "accounts",
        "categories",
        "transactions",
        "schedules",
        "budgets",
    ] {
        snapshot["coverage"][collection] = json!("complete");
    }
    snapshot["liquidity"]["categories"][0]["availability"] = money(0, "USD");
    let mut reserve = snapshot["liquidity"]["categories"][0].clone();
    reserve["categoryId"] = json!("reserve");
    reserve["cashBucketId"] = json!("reserve");
    reserve["availability"] = money(6_000, "USD");
    let mut reserve_two = reserve.clone();
    reserve_two["categoryId"] = json!("reserve-two");
    reserve_two["cashBucketId"] = json!("reserve-two");
    snapshot["liquidity"]["categories"]
        .as_array_mut()
        .expect("normalized category facts are an array")
        .extend([reserve, reserve_two]);
    snapshot["liquidity"]["categories"][2]["availability"] = money(6_000, "USD");
    let checking = snapshot["liquidity"]["accounts"]
        .as_array_mut()
        .expect("normalized accounts are an array")
        .iter_mut()
        .find(|account| account["accountId"] == "checking")
        .expect("canonical checking account exists");
    checking["recordedBalance"] = money(13_000, "USD");

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
        "categoryPolicies": [
            {"categoryId": "food", "kind": "ordinary", "donorEligible": false, "minimumRetained": money(0, "USD"), "projectedRemainingNeed": money(0, "USD")},
            {"categoryId": "reserve", "kind": "ordinary", "donorEligible": true, "minimumRetained": money(1_000, "USD"), "projectedRemainingNeed": money(2_000, "USD")},
            {"categoryId": "reserve-two", "kind": "ordinary", "donorEligible": false, "minimumRetained": money(1_000, "USD"), "projectedRemainingNeed": money(2_000, "USD")}
        ],
        "validUntil": liquidity["validUntil"].clone(),
        "requestId": "request-consequential-action-1",
        "correlationId": "correlation-consequential-action-1",
        "decisionId": "decision-consequential-action-1"
    })
}

fn request() -> Value {
    let fixture = fixture(ACTION_FIXTURE);
    json!({
        "decisionCardRequest": canonical_decision_card_request(),
        "intent": fixture["intent"].clone(),
        "currentLedger": fixture["currentLedger"].clone(),
        "resolvedEvidence": fixture["resolvedEvidence"].clone(),
        "financialPolicyVersion": fixture["financialPolicyVersion"].clone(),
        "evaluatedAt": fixture["evaluatedAt"].clone(),
        "idempotencyKey": fixture["idempotencyKey"].clone(),
        "supplementalObservations": []
    })
}

fn add_supplemental_observation(
    request: &mut Value,
    account_id: &str,
    flow_ids: &[&str],
    obligation_ids: &[&str],
) {
    request["supplementalObservations"]
        .as_array_mut()
        .expect("supplemental observations are an array")
        .push(json!({
            "accountId": account_id,
            "fields": ["currency", "kind", "owned", "currentLedgerConfirmed", "holds", "unsettledFlows", "obligations"],
            "flowIds": flow_ids,
            "obligationIds": obligation_ids
        }));
}

fn add_supplemental_observations(request: &mut Value, account_ids: &[&str]) {
    request["supplementalObservations"] = json!([]);
    for account_id in account_ids {
        add_supplemental_observation(request, account_id, &[], &[]);
    }
}

fn alternate_donor_request() -> Value {
    let action_fixture = fixture(ACTION_FIXTURE);
    let mut input = request();
    input["intent"] = action_fixture["alternateDonorIntent"].clone();
    for eligibility in action_fixture["alternateDonorEligibility"]
        .as_array()
        .expect("alternate donor eligibility fixture is an array")
    {
        let policy = input["decisionCardRequest"]["categoryPolicies"]
            .as_array_mut()
            .expect("category policies are an array")
            .iter_mut()
            .find(|policy| policy["categoryId"] == eligibility["categoryId"])
            .expect("alternate donor category policy exists");
        policy["donorEligible"] = eligibility["donorEligible"].clone();
    }
    input
}

fn evidence_projection_request() -> Value {
    let action_fixture = fixture(ACTION_FIXTURE);
    let mut input = request();
    fund_food(&mut input, 2_000);
    input["decisionCardRequest"]["items"][0]["amount"] = money(500, "USD");
    input["intent"] = action_fixture["evidenceProjectionIntent"].clone();
    input
}

fn plan_request(value: Value) -> Result<Value, String> {
    let request: PlanConsequentialActionRequest =
        serde_json::from_value(value).map_err(|error| error.to_string())?;
    let plan = plan_consequential_action(request).map_err(|error| error.to_string())?;
    serde_json::to_value(plan).map_err(|error| error.to_string())
}

fn plan(value: Value) -> Value {
    plan_request(value).expect("valid consequential action must produce one native plan")
}

fn verify_request(plan: Value, request: Value, phase: &str) -> Value {
    json!({
        "plan": plan,
        "phase": phase,
        "decisionCardRequest": request["decisionCardRequest"].clone(),
        "currentLedger": request["currentLedger"].clone(),
        "resolvedEvidence": request["resolvedEvidence"].clone(),
        "financialPolicyVersion": request["financialPolicyVersion"].clone(),
        "evaluatedAt": request["evaluatedAt"].clone()
    })
}

fn verify(value: Value) -> Value {
    let request: VerifyConsequentialActionRequest =
        serde_json::from_value(value).expect("verification request must satisfy the wire contract");
    serde_json::to_value(
        verify_consequential_action(request)
            .expect("verification inputs must be valid native requests"),
    )
    .expect("verification result must have stable JSON")
}

fn hash_is_sha256(value: &Value) -> bool {
    value.as_str().is_some_and(|hash| {
        hash.len() == 64
            && hash
                .bytes()
                .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    })
}

fn manual_transaction(amount: Value, splits: Vec<Value>) -> Value {
    let category_id = if splits.is_empty() {
        json!("food")
    } else {
        Value::Null
    };
    json!({
        "parentId": "manual-parent-1",
        "correlationId": "manual-correlation-1",
        "accountId": "checking",
        "amount": amount,
        "date": "2026-09-06",
        "categoryId": category_id,
        "payeeName": "Local shop",
        "notes": null,
        "splits": splits
    })
}
fn account_fact_mut<'a>(request: &'a mut Value, account_id: &str) -> &'a mut Value {
    request["decisionCardRequest"]["financialSnapshot"]["liquidity"]["accounts"]
        .as_array_mut()
        .expect("financial account facts are an array")
        .iter_mut()
        .find(|account| account["accountId"] == account_id)
        .expect("requested financial account exists")
}
fn add_legacy_account_from_current_ledger(request: &mut Value, account_id: &str) {
    let current = ledger_account_mut(request, account_id).clone();
    let accounts = request["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]
        ["accounts"]
        .as_array_mut()
        .expect("legacy snapshot accounts are an array");
    if accounts.iter().any(|account| account["id"] == account_id) {
        return;
    }
    accounts.push(json!({
        "id": account_id,
        "name": current["name"],
        "accountType": "checking",
        "offBudget": !current["onBudget"].as_bool().unwrap(),
        "isClosed": current["closed"],
        "clearedBalance": current["balance"],
        "importedBalance": current["balance"],
        "mtid": null
    }));
}

fn set_legacy_account_balance(request: &mut Value, account_id: &str, balance: Value) {
    let account = request["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["accounts"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|account| account["id"] == account_id)
        .expect("legacy account exists");
    account["clearedBalance"] = balance.clone();
    account["importedBalance"] = balance;
}
fn recapture_actual_source(request: &mut Value, captured_at: &str) {
    let (snapshot_id, content_hash) = {
        let snapshot = &mut request["decisionCardRequest"]["financialSnapshot"];
        snapshot["capturedAt"] = json!(captured_at);
        snapshot["snapshotId"] = json!(format!("snapshot-{captured_at}"));
        snapshot["contentHash"] = json!(format!("content-{captured_at}"));
        snapshot["legacySnapshot"]["snapshotDate"] = json!(captured_at);
        snapshot["legacySnapshot"]["actualDownloadedAt"] = json!(captured_at);
        if let Some(liquidity) = snapshot["liquidity"].as_object_mut() {
            liquidity.insert(
                "ledgerContentHash".into(),
                json!(format!("ledger-{captured_at}")),
            );
            for category in liquidity["categories"].as_array_mut().unwrap() {
                let evidence = &mut category["evidence"];
                if evidence["source"] == "actual_ledger" {
                    evidence["observedAt"] = json!(captured_at);
                    evidence["expiresAt"] = Value::Null;
                }
            }
            for account in liquidity["accounts"].as_array_mut().unwrap() {
                for field in [
                    "currencyEvidence",
                    "kindEvidence",
                    "ownershipEvidence",
                    "balanceEvidence",
                    "freshnessEvidence",
                    "activityEvidence",
                    "scheduleEvidence",
                    "holdsEvidence",
                ] {
                    let evidence = &mut account[field];
                    if evidence["source"] == "actual_ledger" {
                        evidence["observedAt"] = json!(captured_at);
                        evidence["expiresAt"] = Value::Null;
                    }
                }
                if let Some(credit) = account["credit"].as_object_mut() {
                    let evidence = &mut credit["evidence"];
                    if evidence["source"] == "actual_ledger" {
                        evidence["observedAt"] = json!(captured_at);
                        evidence["expiresAt"] = Value::Null;
                    }
                }
            }
        }
        if let Some(observations) = snapshot["observations"].as_array_mut() {
            for observation in observations {
                if matches!(
                    observation["kind"].as_str(),
                    Some(
                        "account_collection_coverage"
                            | "account_coverage"
                            | "account_type"
                            | "account_balance"
                            | "pending_activity"
                            | "uncleared_activity"
                    )
                ) && !observation["observedAt"].is_null()
                {
                    observation["observedAt"] = json!(captured_at);
                }
            }
        }
        (
            snapshot["snapshotId"].clone(),
            snapshot["contentHash"].clone(),
        )
    };
    request["decisionCardRequest"]["context"]["snapshotId"] = snapshot_id;
    request["decisionCardRequest"]["context"]["contentHash"] = content_hash;
    request["decisionCardRequest"]["context"]["evaluatedAt"] = json!(captured_at);
    request["evaluatedAt"] = json!(captured_at);
    request["decisionCardRequest"]["requestId"] = json!(format!("request-{captured_at}"));
    request["decisionCardRequest"]["correlationId"] = json!(format!("correlation-{captured_at}"));
    request["decisionCardRequest"]["decisionId"] = json!(format!("decision-{captured_at}"));
    for route in request["decisionCardRequest"]["liquidityPolicy"]["transferRoutes"]
        .as_array_mut()
        .unwrap()
    {
        let evidence = &mut route["evidence"];
        if evidence["source"] == "actual_ledger" {
            evidence["observedAt"] = json!(captured_at);
            evidence["expiresAt"] = Value::Null;
        }
    }
}

fn actual_fact_evidence(state: &str, captured_at: &str, reasons: &[&str]) -> Value {
    json!({
        "state": state,
        "source": "actual_ledger",
        "observedAt": captured_at,
        "expiresAt": null,
        "reasons": reasons
    })
}

fn set_actual_base_balance_evidence(request: &mut Value, account_id: &str, captured_at: &str) {
    account_fact_mut(request, account_id)["balanceEvidence"] = actual_fact_evidence(
        "known",
        captured_at,
        &["ledger_balance_not_in_institution_freshness"],
    );
}

fn apply_actual_account_projection(request: &mut Value, account_id: &str, captured_at: &str) {
    let ledger_account = request["currentLedger"]["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["accountId"] == account_id)
        .expect("current ledger account exists")
        .clone();
    let legacy_account = request["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]
        ["accounts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|account| account["id"] == account_id)
        .expect("legacy account exists")
        .clone();
    let currency = ledger_account["currency"].as_str().unwrap();
    let transactions = request["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]
        ["transactions"]
        .as_array()
        .unwrap();
    let mut baseline_transaction_ids = Vec::new();
    let mut flows = Vec::new();
    let mut has_unverified_transfer_credit = false;
    for transaction in transactions
        .iter()
        .filter(|transaction| transaction["accountId"] == account_id)
    {
        let id = transaction["id"].as_str().unwrap();
        baseline_transaction_ids.push(id.to_owned());
        if let Some(imported_id) = transaction["importedId"].as_str() {
            baseline_transaction_ids.push(imported_id.to_owned());
        }
        let minor_units = transaction["amount"]["minorUnits"]
            .as_str()
            .unwrap()
            .parse::<i64>()
            .unwrap();
        let transfer_id = transaction["transferAccountId"].as_str();
        let imported_id = transaction["importedId"].as_str();
        let reconciled = transaction["reconciled"] == true;
        let include_flow = transaction["cleared"] != true
            || (minor_units > 0 && transfer_id.is_some() && (imported_id.is_none() || !reconciled));
        if !include_flow {
            continue;
        }
        let unverified_transfer_credit =
            minor_units > 0 && transfer_id.is_some() && (imported_id.is_none() || !reconciled);
        has_unverified_transfer_credit |= unverified_transfer_credit;
        flows.push(json!({
            "id": id,
            "economicObligationId": format!("transaction:{id}"),
            "direction": if minor_units < 0 { "outflow" } else { "inflow" },
            "amount": money(minor_units.abs(), currency),
            "includedInBalance": true,
            "matchedTransactionIds": [id],
            "scheduleId": transaction["scheduleId"],
            "transferTransactionId": transaction["transferAccountId"],
            "importedId": transaction["importedId"],
            "reconciled": reconciled,
            "provenance": if imported_id.is_some() { "actual_import" } else { "manual_ledger" }
        }));
    }
    baseline_transaction_ids.sort();
    let activity_reasons: &[&str] = if has_unverified_transfer_credit {
        &["manual_transfer_credit_unverified"]
    } else {
        &[]
    };
    let account = account_fact_mut(request, account_id);
    account["currency"] = json!(currency);
    account["currencyEvidence"] =
        actual_fact_evidence("unknown", captured_at, &["account_currency_not_exposed"]);
    account["kind"] = json!("unknown");
    account["kindEvidence"] =
        actual_fact_evidence("unknown", captured_at, &["account_type_not_exposed"]);
    account["onBudget"] = json!(legacy_account["offBudget"] == false);
    account["closed"] = legacy_account["isClosed"].clone();
    account["owned"] = json!(false);
    account["ownershipEvidence"] =
        actual_fact_evidence("unknown", captured_at, &["account_ownership_not_exposed"]);
    account["recordedBalance"] = ledger_account["balance"].clone();
    account["balanceEvidence"] = actual_fact_evidence(
        "known",
        captured_at,
        &["ledger_balance_not_in_institution_freshness"],
    );
    account["freshnessEvidence"] = actual_fact_evidence(
        "unknown",
        captured_at,
        &["institution_freshness_not_exposed"],
    );
    account["activityEvidence"] = actual_fact_evidence("known", captured_at, activity_reasons);
    account["scheduleEvidence"] = actual_fact_evidence("known", captured_at, &[]);
    account["baselineTransactionIds"] = json!(baseline_transaction_ids);
    account["unsettledFlows"] = json!(flows);
    account["holds"] = money(0, currency);
    account["holdsEvidence"] =
        actual_fact_evidence("unknown", captured_at, &["institution_holds_not_exposed"]);
    account["obligations"] = json!([]);
    account["credit"] = Value::Null;
    account["ambiguityReasons"] = json!([]);
}

fn add_user_attested_flow_and_obligation(request: &mut Value, account_id: &str) {
    let flow_id = format!("supplemental-flow-{account_id}");
    let obligation_id = format!("supplemental-obligation-{account_id}");
    let account = account_fact_mut(request, account_id);
    account["unsettledFlows"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": flow_id.as_str(),
            "economicObligationId": format!("economic-flow-{account_id}"),
            "direction": "outflow",
            "amount": money(1, "USD"),
            "includedInBalance": false,
            "matchedTransactionIds": [],
            "scheduleId": null,
            "transferTransactionId": null,
            "importedId": null,
            "reconciled": false,
            "provenance": "manual_ledger"
        }));
    account["obligations"].as_array_mut().unwrap().push(json!({
        "id": obligation_id.as_str(),
        "economicObligationId": format!("economic-obligation-{account_id}"),
        "categoryId": null,
        "amount": money(1, "USD"),
        "dueAt": "2026-09-07T09:00:00Z",
        "paid": false,
        "includedInBalance": false,
        "matchedTransactionIds": []
    }));
    add_supplemental_observation(
        request,
        account_id,
        &[flow_id.as_str()],
        &[obligation_id.as_str()],
    );
}

fn ledger_account_mut<'a>(request: &'a mut Value, account_id: &str) -> &'a mut Value {
    request["currentLedger"]["accounts"]
        .as_array_mut()
        .expect("current ledger accounts are an array")
        .iter_mut()
        .find(|account| account["accountId"] == account_id)
        .expect("requested current account exists")
}

fn category_fact_mut<'a>(request: &'a mut Value, category_id: &str) -> &'a mut Value {
    request["decisionCardRequest"]["financialSnapshot"]["liquidity"]["categories"]
        .as_array_mut()
        .expect("financial category facts are an array")
        .iter_mut()
        .find(|category| category["categoryId"] == category_id)
        .expect("requested financial category exists")
}

fn assignment_mut<'a>(request: &'a mut Value, category_id: &str) -> &'a mut Value {
    request["currentLedger"]["assignments"]
        .as_array_mut()
        .expect("current budget assignments are an array")
        .iter_mut()
        .find(|assignment| assignment["categoryId"] == category_id)
        .expect("requested current assignment exists")
}

fn fund_food(request: &mut Value, minor_units: i64) {
    assignment_mut(request, "food")["amount"] = money(minor_units, "USD");
    category_fact_mut(request, "food")["availability"] = money(minor_units, "USD");
}

fn actual_manual_row(intent: &Value) -> Value {
    json!({
        "parentId": intent["parentId"],
        "accountId": intent["accountId"],
        "amount": intent["amount"],
        "date": intent["date"],
        "categoryId": intent["categoryId"],
        "payeeName": intent["payeeName"],
        "notes": intent["notes"],
        "splits": intent["splits"],
        "transferAccountId": Value::Null
    })
}

fn apply_manual_postconditions(
    request: &mut Value,
    transaction: &Value,
    checking_balance: i64,
    food_availability: i64,
) {
    ledger_account_mut(request, "checking")["balance"] = money(checking_balance, "USD");
    account_fact_mut(request, "checking")["recordedBalance"] = money(checking_balance, "USD");
    category_fact_mut(request, "food")["availability"] = money(food_availability, "USD");
    request["currentLedger"]["transactions"]
        .as_array_mut()
        .expect("current transactions are an array")
        .push(actual_manual_row(transaction));
}

fn apply_fixture_postconditions(request: &mut Value, profile: &str) {
    let profile = fixture(ACTION_FIXTURE)["postconditions"][profile].clone();
    request["currentLedger"] = profile["currentLedger"].clone();
    for account in profile["financialSnapshot"]["accountBalances"]
        .as_array()
        .expect("postcondition accounts are an array")
    {
        account_fact_mut(request, account["accountId"].as_str().unwrap())["recordedBalance"] =
            account["balance"].clone();
    }
    for category in profile["financialSnapshot"]["categoryAvailability"]
        .as_array()
        .expect("postcondition categories are an array")
    {
        category_fact_mut(request, category["categoryId"].as_str().unwrap())["availability"] =
            category["amount"].clone();
    }
}

fn apply_reallocation_postconditions(request: &mut Value) {
    apply_fixture_postconditions(request, "reallocation");
}

fn apply_wallet_postconditions(request: &mut Value, with_mapping: bool) {
    let mut account = request["currentLedger"]["accounts"][1].clone();
    account["accountId"] = json!("actual-wallet-account-1");
    account["name"] = json!("Emergency savings");
    account["balance"] = money(0, "USD");
    request["currentLedger"]["accounts"]
        .as_array_mut()
        .unwrap()
        .push(account);
    if with_mapping {
        request["currentLedger"]["wallets"]
            .as_array_mut()
            .unwrap()
            .push(json!({"walletId": "wallet-new-1", "accountId": "actual-wallet-account-1"}));
    }
    let mut account_fact =
        request["decisionCardRequest"]["financialSnapshot"]["liquidity"]["accounts"][1].clone();
    account_fact["accountId"] = json!("actual-wallet-account-1");
    account_fact["recordedBalance"] = money(0, "USD");
    request["decisionCardRequest"]["financialSnapshot"]["liquidity"]["accounts"]
        .as_array_mut()
        .unwrap()
        .push(account_fact);
    request["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["accounts"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "actual-wallet-account-1",
            "name": "Emergency savings",
            "accountType": "checking",
            "offBudget": false,
            "isClosed": false,
            "mtid": null,
            "clearedBalance": money(0, "USD"),
            "importedBalance": money(0, "USD")
        }));
    request["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "actual-wallet-transfer-payee-1",
            "name": "Emergency savings",
            "transferAccountId": "actual-wallet-account-1",
            "mtid": null
        }));
}

fn apply_transfer_postconditions(
    request: &mut Value,
    transfer_id: &str,
    correlation_id: &str,
    linked: bool,
) {
    ledger_account_mut(request, "checking")["balance"] = money(12_000, "USD");
    ledger_account_mut(request, "savings")["balance"] = money(21_000, "USD");
    account_fact_mut(request, "checking")["recordedBalance"] = money(12_000, "USD");
    account_fact_mut(request, "savings")["recordedBalance"] = money(21_000, "USD");
    let marker = format!("balanceframe:transfer:{transfer_id}:{correlation_id}");
    let source_link = if linked {
        json!("savings")
    } else {
        Value::Null
    };
    let destination_link = if linked {
        json!("checking")
    } else {
        Value::Null
    };
    request["currentLedger"]["transactions"] = json!([
        {
            "parentId": "actual-transfer-source-1",
            "accountId": "checking",
            "amount": money(-1_000, "USD"),
            "date": "2026-09-06",
            "categoryId": Value::Null,
            "payeeName": Value::Null,
            "notes": marker,
            "splits": [],
            "transferAccountId": source_link
        },
        {
            "parentId": "actual-transfer-destination-1",
            "accountId": "savings",
            "amount": money(1_000, "USD"),
            "date": "2026-09-06",
            "categoryId": Value::Null,
            "payeeName": Value::Null,
            "notes": marker,
            "splits": [],
            "transferAccountId": destination_link
        }
    ]);
    request["currentLedger"]["transfers"] = json!([{
        "transferId": transfer_id,
        "correlationId": correlation_id,
        "marker": marker,
        "sourceTransactionId": "actual-transfer-source-1",
        "destinationTransactionId": "actual-transfer-destination-1",
        "sourceAccountId": "checking",
        "destinationAccountId": "savings",
        "amount": money(1_000, "USD"),
        "date": "2026-09-06"
    }]);
}

#[test]
fn exact_safe_reallocation_binds_tradeoff_source_and_postconditions() {
    let input = request();
    let first = plan(input.clone());
    let second = plan(input.clone());
    assert_eq!(first["version"], "1");
    assert_eq!(first["action"], input["intent"]);
    assert!(hash_is_sha256(&first["actionHash"]));
    assert_eq!(first["actionHash"], second["actionHash"]);
    assert_eq!(first["source"]["snapshotId"], "snapshot-1");
    assert_eq!(first["source"]["policyVersion"], "policy-1");
    assert_eq!(
        first["source"]["financialPolicyVersion"],
        "financial-policy-1"
    );
    assert!(hash_is_sha256(&first["source"]["preconditionsHash"]));
    assert!(hash_is_sha256(&first["source"]["invariantsHash"]));
    assert!(hash_is_sha256(&first["source"]["evidenceHash"]));
    assert_eq!(first["source"]["invalidatedFreshnessAccounts"], json!([]));
    assert_eq!(
        first["expiresAt"],
        input["decisionCardRequest"]["validUntil"]
    );
    assert_eq!(first["idempotencyKey"], input["idempotencyKey"]);
    assert!(first["reasonCodes"]
        .as_array()
        .unwrap()
        .contains(&json!("safe_reallocation")));

    let impact = first["impacts"]
        .as_array()
        .unwrap()
        .iter()
        .find(|impact| impact["kind"] == "category_reallocation")
        .expect("plan retains the typed donor tradeoff");
    assert_eq!(impact["sourceCategoryId"], "reserve");
    assert_eq!(impact["destinationCategoryId"], "food");
    assert_eq!(impact["amount"]["minorUnits"], "2000");
    assert_eq!(impact["sourceProtected"], false);
    assert_eq!(impact["sourceAvailabilityBefore"]["minorUnits"], "6000");
    assert_eq!(impact["sourceAvailabilityAfter"]["minorUnits"], "4000");
    assert_eq!(impact["minimumRetained"]["minorUnits"], "1000");
    assert_eq!(impact["projectedRemainingNeed"]["minorUnits"], "2000");
    assert_eq!(
        impact["safeToRedirectAfter"],
        fixture(ACTION_FIXTURE)["expectedReallocationImpact"]["safeToRedirectAfter"]
    );
    assert_eq!(impact["rationale"], "donor_category_surplus_redirected");

    let postconditions = first["expectedPostconditions"].as_array().unwrap();
    assert!(postconditions.iter().any(|row| row["kind"] == "assignment"
        && row["categoryId"] == "reserve"
        && row["amount"]["minorUnits"] == "4000"));
    assert!(postconditions.iter().any(|row| row["kind"] == "assignment"
        && row["categoryId"] == "food"
        && row["amount"]["minorUnits"] == "2000"));
    assert!(postconditions
        .iter()
        .any(|row| row["kind"] == "account_balance"
            && row["accountId"] == "checking"
            && row["balance"]["minorUnits"] == "13000"));
    assert_eq!(
        first["evidenceReferences"][0]["evidenceId"],
        "checking-freshness"
    );
    assert!(first["impacts"].as_array().unwrap().iter().any(|impact| {
        impact["kind"] == "evidence_resolution"
            && impact["evidenceId"] == "checking-freshness"
            && impact["state"] == "resolved"
    }));
    assert!(!first["impacts"].as_array().unwrap().iter().any(|impact| {
        impact["kind"] == "evidence_resolution" && impact["evidenceId"] == "fd-transaction-pending"
    }));
}

#[test]
fn reallocation_only_plan_preserves_selected_account_and_claim_metadata() {
    let mut input = request();
    input["decisionCardRequest"]["categoryPolicies"][2]["donorEligible"] = json!(true);
    input["decisionCardRequest"]["claimSet"]["revision"] = json!("claims-with-reserve-hold");
    input["decisionCardRequest"]["claimSet"]["bundles"] = json!([{
        "id": "reserve-claim",
        "creationSnapshotId": "snapshot-1",
        "creationPolicyVersion": "policy-1",
        "state": "active",
        "expiresAt": "2026-10-01T00:00:00Z",
        "initiated": false,
        "effects": [{
            "kind": "category",
            "resourceId": "reserve",
            "amount": money(500, "USD"),
            "economicObligationId": "reserve-obligation-1",
            "categoryId": "reserve",
            "includedInBalance": false,
            "matchedTransactionIds": []
        }]
    }]);
    input["decisionCardRequest"]["liquidityPolicy"]["accounts"][1]["paymentEligible"] = json!(true);
    let mut savings_item = input["decisionCardRequest"]["items"][0].clone();
    input["decisionCardRequest"]["items"][0]["routeSelection"]["explicitAccountId"] =
        json!("checking");
    savings_item["id"] = json!("item-savings");
    savings_item["amount"] = money(500, "USD");
    savings_item["routeSelection"]["explicitAccountId"] = json!("savings");
    input["decisionCardRequest"]["items"]
        .as_array_mut()
        .unwrap()
        .push(savings_item);
    input["intent"]["assignments"][0]["amount"] = money(2_500, "USD");

    let planned = plan(input);
    let reasons = planned["reasonCodes"].as_array().unwrap();
    for reason in [
        "account_readiness",
        "payment_route",
        "reservation_commitment",
    ] {
        assert!(reasons.contains(&json!(reason)), "missing {reason} reason");
    }
    let impacts = planned["impacts"].as_array().unwrap();
    for account_id in ["checking", "savings"] {
        assert!(impacts.iter().any(|impact| {
            impact["kind"] == "account_readiness"
                && impact["accountId"] == account_id
                && impact["state"] == "ready"
        }));
        assert!(impacts.iter().any(|impact| {
            impact["kind"] == "payment_route"
                && impact["accountId"] == account_id
                && impact["state"] == "ready"
        }));
    }
    assert!(impacts.iter().any(|impact| {
        impact["kind"] == "reservation_commitment"
            && impact["categoryId"] == "reserve"
            && impact["commitments"] == money(0, "USD")
            && impact["reservations"] == money(500, "USD")
    }));
    assert!(!reasons.contains(&json!("transfer_need")));
    assert!(!impacts
        .iter()
        .any(|impact| impact["kind"] == "transfer_need"));
}

#[test]
fn multiple_donors_share_one_destination_and_assignments_stay_distinct_from_availability() {
    let mut reallocation = request();
    reallocation["decisionCardRequest"]["categoryPolicies"][2]["donorEligible"] = json!(true);
    category_fact_mut(&mut reallocation, "reserve")["availability"] = money(4_000, "USD");
    reallocation["intent"]["assignments"] = json!([
        {
            "sourceCategoryId": "reserve",
            "sourceAsOfMonth": "2026-09",
            "destinationCategoryId": "food",
            "destinationAsOfMonth": "2026-09",
            "amount": money(1_000, "USD")
        },
        {
            "sourceCategoryId": "reserve-two",
            "sourceAsOfMonth": "2026-09",
            "destinationCategoryId": "food",
            "destinationAsOfMonth": "2026-09",
            "amount": money(1_000, "USD")
        }
    ]);
    let planned = plan_request(reallocation.clone())
        .expect("two approved donors may fund the same recipient");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            reallocation.clone(),
            "preconditions"
        ))["valid"],
        true,
        "the same source remains valid when multiple donors fund one destination"
    );
    let mut composite = reallocation.clone();
    composite["intent"] = json!({
        "kind": "composite",
        "actions": [
            {
                "kind": "reallocation",
                "assignments": [reallocation["intent"]["assignments"][0].clone()]
            },
            {
                "kind": "reallocation",
                "assignments": [reallocation["intent"]["assignments"][1].clone()]
            }
        ]
    });
    let composite_plan =
        plan_request(composite.clone()).expect("ordered donors may fund one shared destination");
    assert_eq!(
        verify(verify_request(composite_plan, composite, "preconditions"))["valid"],
        true,
        "ordered composite reallocation remains valid against its original source"
    );
    let mut changed_source = reallocation.clone();
    assignment_mut(&mut changed_source, "reserve")["amount"] = money(5_000, "USD");
    let changed_target = verify(verify_request(
        planned.clone(),
        changed_source,
        "preconditions",
    ));
    assert_eq!(changed_target["valid"], false);
    assert_eq!(changed_target["reason"], "target_changed");
    let assignments = planned["expectedPostconditions"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|condition| condition["kind"] == "assignment")
        .collect::<Vec<_>>();
    assert_eq!(
        assignments.len(),
        3,
        "each category/month has one accumulated target"
    );
    assert!(assignments.iter().any(|condition| {
        condition["categoryId"] == "reserve" && condition["amount"]["minorUnits"] == "5000"
    }));
    assert!(assignments.iter().any(|condition| {
        condition["categoryId"] == "reserve-two" && condition["amount"]["minorUnits"] == "5000"
    }));
    assert!(assignments.iter().any(|condition| {
        condition["categoryId"] == "food" && condition["amount"]["minorUnits"] == "2000"
    }));
    assert_eq!(
        planned["impacts"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|impact| impact["kind"] == "category_reallocation")
            .count(),
        2
    );

    let mut duplicate = reallocation;
    duplicate["intent"]["assignments"] = json!([
        {
            "sourceCategoryId": "reserve",
            "sourceAsOfMonth": "2026-09",
            "destinationCategoryId": "food",
            "destinationAsOfMonth": "2026-09",
            "amount": money(1_000, "USD")
        },
        {
            "sourceCategoryId": "reserve",
            "sourceAsOfMonth": "2026-09",
            "destinationCategoryId": "food",
            "destinationAsOfMonth": "2026-09",
            "amount": money(1_000, "USD")
        }
    ]);
    assert!(
        plan_request(duplicate).is_err(),
        "the same source/destination movement cannot be repeated"
    );

    let mut manual = request();
    fund_food(&mut manual, 2_000);
    manual["decisionCardRequest"]["items"][0]["amount"] = money(1_000, "USD");
    category_fact_mut(&mut manual, "food")["availability"] = money(1_000, "USD");
    manual["intent"] = json!({
        "kind": "manual_transaction",
        "transaction": manual_transaction(money(-1_000, "USD"), vec![])
    });
    assert!(
        plan_request(manual).is_ok(),
        "available envelope funds the purchase even when budgeted assignment differs"
    );
}

#[test]
fn refuses_protected_floor_buffer_and_current_target_failures() {
    let mut protected = request();
    protected["decisionCardRequest"]["categoryPolicies"][1]["kind"] = json!("protected");
    assert!(
        plan_request(protected).is_err(),
        "protected donor cannot fund a move"
    );

    let mut floor = request();
    floor["decisionCardRequest"]["categoryPolicies"][1]["minimumRetained"] = money(5_000, "USD");
    assert!(
        plan_request(floor).is_err(),
        "move must preserve the donor floor"
    );

    let mut buffer = request();
    buffer["decisionCardRequest"]["liquidityPolicy"]["accounts"][0]["protectedBuffer"] =
        money(14_000, "USD");
    buffer["currentLedger"]["accounts"][0]["balance"] = money(13_000, "USD");
    assert!(
        plan_request(buffer).is_err(),
        "cash below its protected buffer cannot fund execution"
    );

    let original = request();
    let original_plan = plan(original);
    let mut changed_current = request();
    changed_current["currentLedger"]["assignments"][1]["amount"] = money(5_500, "USD");
    assert_eq!(
        verify(verify_request(original_plan, changed_current, "preconditions"))["valid"],
        false,
        "changed Actual assignment invalidates the approved source without conflating assignment and availability"
    );

    let mut stale = request();
    stale["evaluatedAt"] = json!("2026-09-08T10:00:00Z");
    assert!(
        plan_request(stale).is_err(),
        "expired source/plan cannot be newly planned"
    );
}

#[test]
fn rejects_funded_or_unsafe_reallocation_sources() {
    let mut fully_funded = request();
    fund_food(&mut fully_funded, 2_000);
    assert!(
        plan_request(fully_funded).is_err(),
        "a fully funded purchase cannot authorize an unnecessary donor move"
    );
    let mut partial_funding_path = request();
    partial_funding_path["intent"]["assignments"][0]["amount"] = money(1_000, "USD");
    assert!(
        plan_request(partial_funding_path).is_err(),
        "an action must execute the complete approved funding path"
    );

    let mut stale_bank = request();
    stale_bank["decisionCardRequest"]["financialSnapshot"]["observations"][0]["state"] =
        json!("stale");
    stale_bank["resolvedEvidence"][0]["state"] = json!("stale");
    assert!(
        plan_request(stale_bank).is_err(),
        "stale bank freshness evidence cannot support reallocation"
    );

    let mut pending_excluded = request();
    pending_excluded["decisionCardRequest"]["financialSnapshot"]["inclusionScope"]
        ["pendingActivity"] = json!("excluded");
    assert!(
        plan_request(pending_excluded).is_err(),
        "excluded pending activity makes the funding source incomplete"
    );

    let mut uncategorized = request();
    uncategorized["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"] = json!([{
        "id": "actual-uncategorized",
        "accountId": "checking",
        "date": "2026-09-06",
        "payeeId": Value::Null,
        "payeeName": "Grocer",
        "categoryId": Value::Null,
        "categoryName": Value::Null,
        "amount": money(-500, "USD"),
        "cleared": false,
        "reconciled": false,
        "importedId": "bank-uncategorized",
        "importedPayee": Value::Null,
        "notes": Value::Null,
        "tags": [],
        "transferAccountId": Value::Null,
        "subtransactions": []
    }]);
    uncategorized["currentLedger"]["transactions"] = json!([{
        "parentId": "actual-uncategorized",
        "accountId": "checking",
        "amount": money(-500, "USD"),
        "date": "2026-09-06",
        "categoryId": Value::Null,
        "payeeName": "Grocer",
        "notes": Value::Null,
        "splits": [],
        "transferAccountId": Value::Null
    }]);
    uncategorized["decisionCardRequest"]["context"]["policy"]["uncategorizedMode"] = json!("block");
    assert!(
        plan_request(uncategorized).is_err(),
        "uncategorized current outflow policy blocks the donor path"
    );

    let mut payment_category = request();
    category_fact_mut(&mut payment_category, "reserve")["kind"] = json!("credit_payment");
    assert!(
        plan_request(payment_category).is_err(),
        "credit-payment categories cannot be reallocation donors"
    );
}

#[test]
fn evidence_projection_must_match_source_normalized_ledger_effect() {
    let mut exact = evidence_projection_request();
    exact["intent"]["transaction"]["parentId"] = json!("projected-parent-1");
    exact["intent"]["transaction"]["correlationId"] = json!("projected-correlation-1");
    assert!(
        plan_request(exact.clone()).is_ok(),
        "an exact source effect may be recorded under new caller-generated ledger identities"
    );

    let mut changed_amount = exact.clone();
    changed_amount["intent"]["transaction"]["amount"] = money(-499, "USD");
    changed_amount["decisionCardRequest"]["items"][0]["amount"] = money(499, "USD");
    assert!(
        plan_request(changed_amount).is_err(),
        "a card-compatible but source-mismatched amount cannot be projected"
    );

    let mut changed_category = exact;
    changed_category["intent"]["transaction"]["categoryId"] = json!("reserve");
    changed_category["decisionCardRequest"]["items"][0]["categoryId"] = json!("reserve");
    assert!(
        plan_request(changed_category).is_err(),
        "a card-compatible but source-mismatched category cannot be projected"
    );
}

#[test]
fn composite_cannot_project_one_economic_event_twice_through_distinct_evidence() {
    let mut input = evidence_projection_request();
    input["decisionCardRequest"]["items"][0]["amount"] = money(1_000, "USD");
    let event = &mut input["decisionCardRequest"]["financialSnapshot"]["observations"][1];
    let mut second_reference = event["evidence"][0].clone();
    second_reference["evidenceId"] = json!("fd-transaction-pending-alias");
    event["evidence"]
        .as_array_mut()
        .unwrap()
        .push(second_reference);
    let mut second_resolution = input["resolvedEvidence"][1].clone();
    second_resolution["evidenceId"] = json!("fd-transaction-pending-alias");
    input["resolvedEvidence"]
        .as_array_mut()
        .unwrap()
        .push(second_resolution);

    let mut second_transaction = input["intent"]["transaction"].clone();
    second_transaction["parentId"] = json!("projected-parent-second");
    second_transaction["correlationId"] = json!("projected-correlation-second");
    let first_transaction = input["intent"]["transaction"].clone();
    input["intent"] = json!({
        "kind": "composite",
        "actions": [
            {
                "kind": "evidence_projection",
                "transaction": first_transaction,
                "evidenceIds": ["fd-transaction-pending"]
            },
            {
                "kind": "evidence_projection",
                "transaction": second_transaction,
                "evidenceIds": ["fd-transaction-pending-alias"]
            }
        ]
    });
    assert!(
        plan_request(input).is_err(),
        "different resolved references cannot authorize duplicate effects for one economic subject"
    );
}

#[test]
fn plans_every_closed_action_and_binds_composite_atoms() {
    let alternate = plan(alternate_donor_request());
    assert_eq!(
        alternate["action"]["assignments"][0]["sourceCategoryId"],
        "reserve-two"
    );
    assert_eq!(
        alternate["action"]["assignments"][0]["destinationCategoryId"],
        "food"
    );
    let mut manual = request();
    fund_food(&mut manual, 2_000);
    manual["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-2_000, "USD"), vec![]
    )});
    let manual_plan = plan(manual);
    assert_eq!(manual_plan["action"]["kind"], "manual_transaction");
    assert!(manual_plan["expectedPostconditions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|condition| condition["kind"] == "transaction"
            && condition["parentId"] == "manual-parent-1"));

    let mut split = request();
    fund_food(&mut split, 2_000);
    split["decisionCardRequest"]["items"][0]["categoryAllocations"] = json!([
        {"categoryId": "food", "amount": money(1_200, "USD")},
        {"categoryId": "reserve", "amount": money(800, "USD")}
    ]);
    split["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-2_000, "USD"), vec![
            json!({"categoryId": "food", "amount": money(-1_200, "USD")}),
            json!({"categoryId": "reserve", "amount": money(-800, "USD")})
        ]
    )});
    assert_eq!(
        plan(split)["action"]["transaction"]["splits"]
            .as_array()
            .unwrap()
            .len(),
        2
    );

    let projection = evidence_projection_request();
    let projection_plan = plan(projection);
    assert_eq!(projection_plan["action"]["kind"], "evidence_projection");
    let event_evidence = projection_plan["evidenceReferences"]
        .as_array()
        .unwrap()
        .iter()
        .find(|evidence| evidence["evidenceId"] == "fd-transaction-pending")
        .expect("event evidence is represented in the plan");
    assert_eq!(event_evidence["version"], "fd-resolution/1");
    assert_eq!(event_evidence["subjectId"], "manual-parent-evidence-1");
    assert_eq!(
        event_evidence["contentHash"],
        "fd-transaction-pending-content-1"
    );
    assert!(projection_plan["impacts"]
        .as_array()
        .unwrap()
        .iter()
        .any(|impact| impact["kind"] == "evidence_resolution" && impact["state"] == "resolved"));

    let mut wallet = request();
    wallet["intent"] = json!({
        "kind": "wallet_materialization", "walletId": "wallet-new-1",
        "accountName": "Emergency savings", "currency": "USD"
    });
    let wallet_plan = plan(wallet.clone());

    let mut unsupported_wallet_currency = request();
    unsupported_wallet_currency["intent"] = json!({
        "kind": "wallet_materialization", "walletId": "wallet-eur-1",
        "accountName": "Foreign-currency wallet", "currency": "EUR"
    });
    assert_eq!(
        plan_request(unsupported_wallet_currency)
            .expect_err("wallet currency must come from trusted source currency metadata"),
        "wallet_currency_not_configured"
    );
    let mut changed_wallet = wallet;
    changed_wallet["intent"]["walletId"] = json!("wallet-new-2");
    assert_ne!(
        wallet_plan["actionHash"],
        plan(changed_wallet)["actionHash"]
    );
    assert!(wallet_plan["expectedPostconditions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|condition| condition["kind"] == "wallet_mapping"
            && condition["walletId"] == "wallet-new-1"
            && condition["onBudget"] == true
            && condition["closed"] == false
            && condition["openingBalance"]["minorUnits"] == "0"));

    let mut manual_identity = request();
    fund_food(&mut manual_identity, 2_000);
    manual_identity["intent"] = json!({
        "kind": "manual_transaction", "transaction": manual_transaction(money(-2_000, "USD"), vec![])
    });
    let original_parent = plan(manual_identity.clone());
    manual_identity["intent"]["transaction"]["parentId"] = json!("manual-parent-2");
    assert_ne!(
        original_parent["actionHash"],
        plan(manual_identity)["actionHash"]
    );

    let evidence_identity = evidence_projection_request();
    let original_evidence = plan(evidence_identity.clone());
    let mut changed_evidence_content = evidence_identity.clone();
    changed_evidence_content["resolvedEvidence"][1]["contentHash"] = json!("content-revision-2");
    changed_evidence_content["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["contentHash"] = json!("content-revision-2");
    assert_ne!(
        original_evidence["actionHash"],
        plan(changed_evidence_content)["actionHash"]
    );
    let mut changed_evidence_version = evidence_identity;
    changed_evidence_version["resolvedEvidence"][1]["version"] = json!("fd-resolution/2");
    changed_evidence_version["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["version"] = json!("fd-resolution/2");
    assert_ne!(
        original_evidence["actionHash"],
        plan(changed_evidence_version)["actionHash"]
    );

    let mut transfer = request();
    transfer["intent"] = json!({
        "kind": "transfer", "transferId": "ledger-transfer-1", "correlationId": "transfer-correlation-1",
        "sourceAccountId": "checking", "destinationAccountId": "savings",
        "amount": money(1_000, "USD"), "date": "2026-09-06"
    });
    let transfer_plan = plan(transfer);
    assert!(transfer_plan["expectedPostconditions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|condition| condition["kind"] == "transfer_ledger_entry"
            && condition["transferId"] == "ledger-transfer-1"));

    let mut composite = request();
    composite["intent"] = fixture(ACTION_FIXTURE)["compositeIntent"].clone();
    let first = plan(composite.clone());
    assert_eq!(first["action"]["kind"], "composite");
    assert_eq!(first["action"]["actions"].as_array().unwrap().len(), 2);
    assert!(hash_is_sha256(&first["actionHash"]));
    let mut changed_amount = composite.clone();
    changed_amount["intent"]["actions"][1]["transaction"]["amount"] = money(-501, "USD");
    assert!(
        plan_request(changed_amount).is_err(),
        "a changed composite debit must still match its bound cart"
    );
    composite["intent"]["actions"][1]["transaction"]["notes"] = json!("Exact composite purchase");
    let changed = plan(composite);
    assert_ne!(
        first["actionHash"], changed["actionHash"],
        "hash binds every ordered composite effect"
    );

    let mut duplicate_path = request();
    let assignment = duplicate_path["intent"]["assignments"][0].clone();
    duplicate_path["intent"]["assignments"]
        .as_array_mut()
        .unwrap()
        .push(assignment);
    assert!(
        plan_request(duplicate_path).is_err(),
        "one category-month effect cannot be applied twice"
    );
}

#[test]
fn rejects_bad_ids_currency_evidence_split_totals_and_checked_arithmetic() {
    let mut bad_id = request();
    bad_id["intent"]["assignments"][0]["sourceCategoryId"] = json!("missing-category");
    assert!(plan_request(bad_id).is_err());

    let mut bad_currency = request();
    bad_currency["intent"]["assignments"][0]["amount"] = money(2_000, "EUR");
    assert!(plan_request(bad_currency).is_err());

    let mut stale_evidence = evidence_projection_request();
    stale_evidence["resolvedEvidence"][1]["state"] = json!("stale");
    assert!(plan_request(stale_evidence).is_err());
    let mut unresolved_event = evidence_projection_request();
    unresolved_event["decisionCardRequest"]["financialSnapshot"]["observations"][1]["state"] =
        json!("stale");
    assert!(
        plan_request(unresolved_event).is_err(),
        "event resolution must still be current"
    );

    let mut untrusted_event = evidence_projection_request();
    untrusted_event["decisionCardRequest"]["financialSnapshot"]["observations"][1]["evidence"][0]
        ["authorized"] = json!(false);
    assert!(
        plan_request(untrusted_event).is_err(),
        "event evidence must be authorized"
    );
    let mut wrong_evidence_kind = evidence_projection_request();
    wrong_evidence_kind["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["evidence"][0]["kind"] = json!("transaction_resolution");
    assert!(
        plan_request(wrong_evidence_kind).is_err(),
        "event reference kind is exact"
    );
    let mut redacted_event = evidence_projection_request();
    redacted_event["decisionCardRequest"]["financialSnapshot"]["observations"][1]["evidence"][0]
        ["redaction"] = json!("redacted");
    assert!(
        plan_request(redacted_event).is_err(),
        "event evidence must be visible"
    );
    let mut missing_event_evidence = evidence_projection_request();
    missing_event_evidence["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["evidence"] = json!([]);
    assert!(
        plan_request(missing_event_evidence).is_err(),
        "event resolution requires evidence"
    );

    let mut missing_event_effect = evidence_projection_request();
    missing_event_effect["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        .as_object_mut()
        .unwrap()
        .remove("ledgerEffect");
    assert!(
        plan_request(missing_event_effect).is_err(),
        "resolved economic events require a source-normalized ledger effect"
    );

    let mut non_event_effect = request();
    non_event_effect["decisionCardRequest"]["financialSnapshot"]["observations"][0]
        ["ledgerEffect"] = fixture(ACTION_FIXTURE)["sourceObservation"]["ledgerEffect"].clone();
    assert!(
        plan_request(non_event_effect).is_err(),
        "only resolved economic events may carry a source ledger effect"
    );

    let mut wrong_subject = evidence_projection_request();
    wrong_subject["decisionCardRequest"]["financialSnapshot"]["observations"][1]["scope"]["id"] =
        json!("different-parent");
    assert!(
        plan_request(wrong_subject).is_err(),
        "event subject must bind to the evidence reference"
    );
    let mut mismatched_event_content = evidence_projection_request();
    mismatched_event_content["resolvedEvidence"][1]["contentHash"] = json!("different-content");
    assert!(
        plan_request(mismatched_event_content).is_err(),
        "event content hash must match resolved evidence"
    );
    let mut mismatched_event_version = evidence_projection_request();
    mismatched_event_version["resolvedEvidence"][1]["version"] = json!("fd-resolution/2");
    assert!(
        plan_request(mismatched_event_version).is_err(),
        "event version must match resolved evidence"
    );

    let mut missing_event_version = evidence_projection_request();
    missing_event_version["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["version"] = json!("");
    assert!(
        plan_request(missing_event_version).is_err(),
        "event version is required"
    );
    let mut unknown_event_field = evidence_projection_request();
    unknown_event_field["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["unexpected"] = json!(true);
    assert!(
        plan_request(unknown_event_field).is_err(),
        "event observation wire is strict"
    );

    let mut duplicate_event = evidence_projection_request();
    let duplicate =
        duplicate_event["decisionCardRequest"]["financialSnapshot"]["observations"][1].clone();
    duplicate_event["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert!(
        plan_request(duplicate_event).is_err(),
        "event resolution subject must be unique"
    );

    let mut wrong_total = request();
    fund_food(&mut wrong_total, 2_000);
    wrong_total["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-1_000, "USD"), vec![json!({"categoryId": "food", "amount": money(-999, "USD")})]
    )});
    assert!(
        plan_request(wrong_total).is_err(),
        "split children must conserve the parent total exactly"
    );

    let mut overflow = request();
    fund_food(&mut overflow, 2_000);
    overflow["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-1_000, "USD"), vec![
            json!({"categoryId": "food", "amount": money(-9_223_372_036_854_775_807_i64, "USD")}),
            json!({"categoryId": "reserve", "amount": money(-2, "USD")})
        ]
    )});
    assert!(
        plan_request(overflow).is_err(),
        "split sum must use checked signed-i64 arithmetic"
    );
}

#[test]
fn supplemental_invalidation_rejects_actual_and_baseline_linked_flows() {
    let mut actual_flow = request();
    fund_food(&mut actual_flow, 2_000);
    actual_flow["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-1_000, "USD"), vec![]
    )});
    account_fact_mut(&mut actual_flow, "checking")["unsettledFlows"] = json!([{
        "id": "actual-import-flow",
        "economicObligationId": "actual-import-obligation",
        "direction": "outflow",
        "amount": money(100, "USD"),
        "includedInBalance": false,
        "matchedTransactionIds": [],
        "scheduleId": null,
        "transferTransactionId": null,
        "importedId": "actual-import-1",
        "reconciled": false,
        "provenance": "actual_import"
    }]);
    add_supplemental_observation(&mut actual_flow, "checking", &["actual-import-flow"], &[]);
    assert!(plan_request(actual_flow)
        .unwrap_err()
        .contains("invalid_supplemental_flow_binding"));

    let mut baseline_linked = request();
    fund_food(&mut baseline_linked, 2_000);
    baseline_linked["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-1_000, "USD"), vec![]
    )});
    account_fact_mut(&mut baseline_linked, "checking")["baselineTransactionIds"] =
        json!(["actual-baseline-1"]);
    account_fact_mut(&mut baseline_linked, "checking")["unsettledFlows"] = json!([{
        "id": "manual-flow-linked-to-actual",
        "economicObligationId": "linked-obligation",
        "direction": "outflow",
        "amount": money(100, "USD"),
        "includedInBalance": false,
        "matchedTransactionIds": ["actual-baseline-1"],
        "scheduleId": null,
        "transferTransactionId": null,
        "importedId": null,
        "reconciled": false,
        "provenance": "manual_ledger"
    }]);
    add_supplemental_observation(
        &mut baseline_linked,
        "checking",
        &["manual-flow-linked-to-actual"],
        &[],
    );
    assert!(plan_request(baseline_linked)
        .unwrap_err()
        .contains("invalid_supplemental_flow_binding"));
}

#[test]
fn verification_rechecks_evidence_and_normalizes_only_capture_metadata() {
    let input = request();
    let planned = plan(input.clone());
    let before = verify(verify_request(
        planned.clone(),
        input.clone(),
        "preconditions",
    ));
    assert_eq!(before["valid"], true);
    assert_eq!(before["reason"], Value::Null);
    assert_eq!(before["actionHash"], planned["actionHash"]);

    let mut refreshed = input.clone();
    refreshed["decisionCardRequest"]["financialSnapshot"]["snapshotId"] =
        json!("snapshot-refreshed");
    refreshed["decisionCardRequest"]["financialSnapshot"]["contentHash"] =
        json!("content-refreshed");
    refreshed["decisionCardRequest"]["financialSnapshot"]["capturedAt"] =
        json!("2026-09-06T10:01:00Z");
    refreshed["decisionCardRequest"]["context"]["snapshotId"] = json!("snapshot-refreshed");
    refreshed["decisionCardRequest"]["context"]["contentHash"] = json!("content-refreshed");
    refreshed["decisionCardRequest"]["context"]["evaluatedAt"] = json!("2026-09-06T10:01:00Z");
    assert_eq!(
        verify(verify_request(planned.clone(), refreshed, "preconditions"))["valid"],
        true,
        "refreshed capture labels/times alone are non-material"
    );

    let mut evidence_clock = input.clone();
    evidence_clock["decisionCardRequest"]["financialSnapshot"]["observations"][0]["observedAt"] =
        json!("2026-09-06T09:59:00Z");
    let changed_clock = verify(verify_request(
        planned.clone(),
        evidence_clock,
        "preconditions",
    ));
    assert_eq!(
        changed_clock["valid"], false,
        "source evidence clocks remain material"
    );
    assert_eq!(changed_clock["reason"], "evidence_changed");

    let mut stale_bank = input.clone();
    stale_bank["decisionCardRequest"]["financialSnapshot"]["observations"][0]["state"] =
        json!("stale");
    stale_bank["resolvedEvidence"][0]["state"] = json!("stale");
    let stale_bank_result = verify(verify_request(planned.clone(), stale_bank, "preconditions"));
    assert_eq!(stale_bank_result["valid"], false);
    assert_eq!(stale_bank_result["reason"], "evidence_changed");

    let mut evidence_expiry = input.clone();
    evidence_expiry["decisionCardRequest"]["financialSnapshot"]["liquidity"]["accounts"][0]
        ["balanceEvidence"]["expiresAt"] = json!("2026-09-06T09:59:00Z");
    let changed_expiry = verify(verify_request(
        planned.clone(),
        evidence_expiry,
        "preconditions",
    ));
    assert_eq!(
        changed_expiry["valid"], false,
        "evidence expiry is never normalized away"
    );
    assert_eq!(changed_expiry["reason"], "evidence_changed");

    let mut evidence_content = input.clone();
    evidence_content["resolvedEvidence"][0]["contentHash"] = json!("different-evidence-content");
    let changed_content = verify(verify_request(
        planned.clone(),
        evidence_content,
        "preconditions",
    ));
    assert_eq!(changed_content["valid"], false);
    assert_eq!(changed_content["reason"], "evidence_changed");

    let event_input = evidence_projection_request();
    let event_plan = plan(event_input.clone());
    let mut changed_event_version = event_input.clone();
    changed_event_version["resolvedEvidence"][1]["version"] = json!("fd-resolution/2");
    let changed_version = verify(verify_request(
        event_plan.clone(),
        changed_event_version,
        "preconditions",
    ));
    assert_eq!(
        changed_version["valid"], false,
        "resolved evidence version is plan-bound"
    );

    let mut changed_event_content = event_input.clone();
    changed_event_content["resolvedEvidence"][1]["contentHash"] = json!("event-content-2");
    changed_event_content["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["contentHash"] = json!("event-content-2");
    let changed_event_plan = plan(changed_event_content.clone());
    assert_ne!(event_plan["actionHash"], changed_event_plan["actionHash"]);
    assert_eq!(
        verify(verify_request(
            event_plan.clone(),
            changed_event_content,
            "preconditions"
        ))["valid"],
        false,
        "source event content is material"
    );

    let mut changed_source_effect = event_input.clone();
    changed_source_effect["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["ledgerEffect"]["amount"] = money(-501, "USD");
    let changed_effect = verify(verify_request(
        event_plan.clone(),
        changed_source_effect,
        "preconditions",
    ));
    assert_eq!(changed_effect["valid"], false);
    assert_eq!(
        changed_effect["reason"], "evidence_changed",
        "a changed source-normalized effect is an evidence change"
    );

    let mut changed_observation_version = event_input.clone();
    changed_observation_version["decisionCardRequest"]["financialSnapshot"]["observations"][1]
        ["version"] = json!("fd-resolution/2");
    assert_eq!(
        verify(verify_request(
            event_plan,
            changed_observation_version,
            "preconditions"
        ))["valid"],
        false,
        "source event resolution version is material"
    );

    let mut post_input = input.clone();
    apply_reallocation_postconditions(&mut post_input);
    post_input["decisionCardRequest"]["financialSnapshot"]["snapshotId"] =
        json!("snapshot-after-write");
    post_input["decisionCardRequest"]["financialSnapshot"]["contentHash"] =
        json!("content-after-write");
    post_input["decisionCardRequest"]["financialSnapshot"]["capturedAt"] =
        json!("2026-09-06T10:02:00Z");
    post_input["decisionCardRequest"]["context"]["snapshotId"] = json!("snapshot-after-write");
    post_input["decisionCardRequest"]["context"]["contentHash"] = json!("content-after-write");
    post_input["decisionCardRequest"]["context"]["evaluatedAt"] = json!("2026-09-06T10:02:00Z");
    post_input["evaluatedAt"] = json!("2026-09-06T10:02:00Z");
    let post = verify(verify_request(
        planned.clone(),
        post_input.clone(),
        "postconditions",
    ));
    assert_eq!(
        post["valid"], true,
        "exact authorized effects reverse to the original material source"
    );

    let mut expired_recovery = post_input.clone();
    expired_recovery["evaluatedAt"] = json!("2026-09-07T18:00:00Z");
    let recovered = verify(verify_request(
        planned.clone(),
        expired_recovery,
        "postconditions",
    ));
    assert_eq!(
        recovered["valid"], true,
        "read-only postcondition recovery remains possible after expiry"
    );

    let mut same_record_edit = post_input.clone();
    ledger_account_mut(&mut same_record_edit, "checking")["name"] = json!("Externally renamed");
    let edited_record = verify(verify_request(
        planned.clone(),
        same_record_edit,
        "postconditions",
    ));
    assert_eq!(
        edited_record["valid"], false,
        "an unrelated change in an affected record is not masked"
    );
    assert_eq!(edited_record["reason"], "source_changed");

    let mut target_edit = post_input.clone();
    assignment_mut(&mut target_edit, "reserve")["amount"] = money(3_999, "USD");
    let edited_target = verify(verify_request(
        planned.clone(),
        target_edit,
        "postconditions",
    ));
    assert_eq!(
        edited_target["valid"], false,
        "actual assignment mismatch fails deterministic postconditions"
    );
    assert_eq!(edited_target["reason"], "postcondition_mismatch");

    let mut source_edit = input.clone();
    source_edit["decisionCardRequest"]["financialSnapshot"]["liquidity"]["accounts"][0]
        ["recordedBalance"] = money(12_000, "USD");
    let changed_source = verify(verify_request(
        planned.clone(),
        source_edit,
        "preconditions",
    ));
    assert_eq!(
        changed_source["valid"], false,
        "material source change invalidates the exact plan"
    );
    assert_eq!(changed_source["reason"], "source_changed");

    let mut changed_policy = input.clone();
    changed_policy["financialPolicyVersion"] = json!("financial-policy-2");
    let policy_result = verify(verify_request(
        planned.clone(),
        changed_policy,
        "preconditions",
    ));
    assert_eq!(policy_result["valid"], false);
    assert_eq!(policy_result["reason"], "policy_changed");

    let mut changed_pending_treatment = input.clone();
    changed_pending_treatment["decisionCardRequest"]["financialSnapshot"]["inclusionScope"]
        ["pendingActivity"] = json!("excluded");
    let pending_result = verify(verify_request(
        planned.clone(),
        changed_pending_treatment,
        "preconditions",
    ));
    assert_eq!(pending_result["valid"], false);
    assert_eq!(pending_result["reason"], "source_changed");

    let mut changed_uncategorized_policy = input.clone();
    changed_uncategorized_policy["decisionCardRequest"]["context"]["policy"]["uncategorizedMode"] =
        json!("block");
    let uncategorized_result = verify(verify_request(
        planned.clone(),
        changed_uncategorized_policy,
        "preconditions",
    ));
    assert_eq!(uncategorized_result["valid"], false);
    assert_eq!(uncategorized_result["reason"], "source_changed");

    let mut stale_funding_path = input.clone();
    stale_funding_path["decisionCardRequest"]["categoryPolicies"][1]["donorEligible"] =
        json!(false);
    let stale_path_result = verify(verify_request(
        planned.clone(),
        stale_funding_path,
        "preconditions",
    ));
    assert_eq!(stale_path_result["valid"], false);
    assert_eq!(stale_path_result["reason"], "source_changed");

    let mut tampered_plan = planned.clone();
    tampered_plan["actionHash"] = json!("f".repeat(64));
    let hash_result = verify(verify_request(
        tampered_plan,
        input.clone(),
        "preconditions",
    ));
    assert_eq!(hash_result["valid"], false);
    assert_eq!(hash_result["reason"], "invalid_plan");

    let mut expired_write = input;
    expired_write["evaluatedAt"] = json!("2026-09-07T18:00:00Z");
    let expired_result = verify(verify_request(planned, expired_write, "preconditions"));
    assert_eq!(expired_result["valid"], false);
    assert_eq!(expired_result["reason"], "expired");
}

#[test]
fn actual_capture_clocks_and_older_bank_observations_are_stable_but_evidence_changes_are_not() {
    let mut input = request();
    input["decisionCardRequest"]["financialSnapshot"]["observations"][0]["observedAt"] =
        json!("2026-09-06T09:30:00Z");
    add_supplemental_observations(&mut input, &["checking", "savings"]);
    input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .extend([
            json!({
                "kind": "account_collection_coverage",
                "scope": {"kind": "global"},
                "state": "complete",
                "observedAt": EVALUATED_AT,
                "evidence": []
            }),
            json!({
                "kind": "account_coverage",
                "scope": {"kind": "account", "id": "checking"},
                "state": "complete",
                "observedAt": EVALUATED_AT,
                "evidence": [{
                    "evidenceId": "checking",
                    "kind": "account",
                    "authorized": true,
                    "redaction": "visible"
                }]
            }),
            json!({
                "kind": "account_type",
                "scope": {"kind": "account", "id": "checking"},
                "state": "complete",
                "observedAt": EVALUATED_AT,
                "evidence": [{
                    "evidenceId": "checking",
                    "kind": "account",
                    "authorized": true,
                    "redaction": "visible"
                }]
            }),
            json!({
                "kind": "account_balance",
                "scope": {"kind": "account", "id": "checking"},
                "state": "complete",
                "observedAt": EVALUATED_AT,
                "evidence": [{
                    "evidenceId": "checking",
                    "kind": "account",
                    "authorized": true,
                    "redaction": "visible"
                }]
            }),
            json!({
                "kind": "pending_activity",
                "scope": {"kind": "account", "id": "savings"},
                "state": "included",
                "observedAt": EVALUATED_AT,
                "evidence": [{
                    "evidenceId": "actual-pending-transaction-1",
                    "kind": "transaction",
                    "authorized": true,
                    "redaction": "visible"
                }]
            }),
            json!({
                "kind": "uncleared_activity",
                "scope": {"kind": "account", "id": "savings"},
                "state": "included",
                "observedAt": EVALUATED_AT,
                "evidence": [{
                    "evidenceId": "actual-uncleared-transaction-1",
                    "kind": "transaction",
                    "authorized": true,
                    "redaction": "visible"
                }]
            }),
        ]);
    input["decisionCardRequest"]["financialSnapshot"]["inclusionScope"] = json!({
        "pendingActivity": "included",
        "unclearedActivity": "included"
    });
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"] = json!([
        {
            "id": "actual-pending-transaction-1",
            "accountId": "savings",
            "date": "2026-09-05",
            "payeeId": null,
            "payeeName": "Market",
            "categoryId": "food",
            "categoryName": "Food",
            "amount": money(-500, "USD"),
            "cleared": false,
            "reconciled": false,
            "importedId": null,
            "importedPayee": null,
            "notes": null,
            "tags": [],
            "transferAccountId": null,
            "subtransactions": []
        },
        {
            "id": "actual-uncleared-transaction-1",
            "accountId": "savings",
            "date": "2026-09-04",
            "payeeId": null,
            "payeeName": "Corner store",
            "categoryId": "food",
            "categoryName": "Food",
            "amount": money(-250, "USD"),
            "cleared": true,
            "reconciled": false,
            "importedId": null,
            "importedPayee": null,
            "notes": null,
            "tags": [],
            "transferAccountId": null,
            "subtransactions": []
        }
    ]);
    input["currentLedger"]["transactions"] = json!([
        {
            "parentId": "actual-pending-transaction-1",
            "accountId": "savings",
            "amount": money(-500, "USD"),
            "date": "2026-09-05",
            "categoryId": "food",
            "payeeName": "Market",
            "notes": null,
            "splits": [],
            "transferAccountId": null
        },
        {
            "parentId": "actual-uncleared-transaction-1",
            "accountId": "savings",
            "amount": money(-250, "USD"),
            "date": "2026-09-04",
            "categoryId": "food",
            "payeeName": "Corner store",
            "notes": null,
            "splits": [],
            "transferAccountId": null
        }
    ]);
    let mut account_evidence = input["resolvedEvidence"][0].clone();
    account_evidence["evidenceId"] = json!("checking");
    input["resolvedEvidence"]
        .as_array_mut()
        .unwrap()
        .push(account_evidence);
    set_actual_base_balance_evidence(&mut input, "checking", EVALUATED_AT);
    recapture_actual_source(&mut input, "2026-09-06T10:00:00Z");
    let planned = plan(input.clone());

    let mut recaptured = input.clone();
    recapture_actual_source(&mut recaptured, "2026-09-06T10:01:00Z");
    let stable = verify(verify_request(
        planned.clone(),
        recaptured.clone(),
        "preconditions",
    ));
    assert_eq!(
        stable["valid"], true,
        "new Actual capture clocks do not change source material"
    );
    let mut changed_actual_state = recaptured.clone();
    let account_balance = changed_actual_state["decisionCardRequest"]["financialSnapshot"]
        ["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|observation| observation["kind"] == "account_balance")
        .unwrap();
    account_balance["state"] = json!("unavailable");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            changed_actual_state,
            "preconditions"
        ))["reason"],
        "evidence_changed",
        "normalization cannot hide a changed Actual observation state"
    );
    let mut versioned_actual_type = recaptured.clone();
    let account_type = versioned_actual_type["decisionCardRequest"]["financialSnapshot"]
        ["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|observation| observation["kind"] == "account_type")
        .unwrap();
    account_type["version"] = json!("source-type/v1");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            versioned_actual_type,
            "preconditions"
        ))["reason"],
        "evidence_changed",
        "capture normalization preserves source-versioned account type evidence"
    );

    let mut changed_actual_timestamp = recaptured.clone();
    let account_balance = changed_actual_timestamp["decisionCardRequest"]["financialSnapshot"]
        ["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|observation| observation["kind"] == "account_balance")
        .unwrap();
    account_balance["observedAt"] = json!("2026-09-06T09:59:00Z");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            changed_actual_timestamp,
            "preconditions"
        ))["reason"],
        "evidence_changed",
        "a non-capture time remains part of Actual observation evidence"
    );

    let mut changed_pending_clock = recaptured.clone();
    let pending_observation = changed_pending_clock["decisionCardRequest"]["financialSnapshot"]
        ["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|observation| observation["kind"] == "pending_activity")
        .unwrap();
    pending_observation["observedAt"] = json!("2026-09-06T09:59:00Z");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            changed_pending_clock,
            "preconditions"
        ))["reason"],
        "evidence_changed",
        "only the exact Actual capture clock is normalized"
    );
    let mut changed_pending_identity = recaptured.clone();
    let pending_observation = changed_pending_identity["decisionCardRequest"]["financialSnapshot"]
        ["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|observation| observation["kind"] == "pending_activity")
        .unwrap();
    pending_observation["evidence"][0]["evidenceId"] = json!("revised-transaction-identity");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            changed_pending_identity,
            "preconditions"
        ))["reason"],
        "evidence_changed",
        "generated observation evidence identity remains source-bound"
    );

    let mut changed_horizon = recaptured.clone();
    changed_horizon["decisionCardRequest"]["context"]["horizon"]["endsAt"] =
        json!("2026-10-02T00:00:00Z");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            changed_horizon,
            "preconditions"
        ))["reason"],
        "source_changed"
    );
    let mut changed_valid_until = recaptured.clone();
    changed_valid_until["decisionCardRequest"]["validUntil"] = json!("2026-09-06T19:00:00Z");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            changed_valid_until,
            "preconditions"
        ))["reason"],
        "source_changed"
    );

    let mut changed_bank = recaptured.clone();
    changed_bank["decisionCardRequest"]["financialSnapshot"]["observations"][0]["observedAt"] =
        json!("2026-09-06T09:29:00Z");
    let changed_bank = verify(verify_request(
        planned.clone(),
        changed_bank,
        "preconditions",
    ));
    assert_eq!(changed_bank["reason"], "evidence_changed");

    let mut changed_user_attestation_clock = recaptured.clone();
    category_fact_mut(&mut changed_user_attestation_clock, "food")["evidence"]["observedAt"] =
        json!("2026-09-06T08:00:00Z");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            changed_user_attestation_clock,
            "preconditions"
        ))["reason"],
        "evidence_changed",
        "user-attested fact observation times remain evidence-bound"
    );
    let mut changed_user_attestation_expiry = recaptured.clone();
    category_fact_mut(&mut changed_user_attestation_expiry, "food")["evidence"]["expiresAt"] =
        json!("2026-09-07T10:00:00Z");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            changed_user_attestation_expiry,
            "preconditions"
        ))["reason"],
        "evidence_changed",
        "user-attested fact expiry remains evidence-bound"
    );
    let mut changed_attestation = recaptured.clone();
    changed_attestation["decisionCardRequest"]["financialSnapshot"]["liquidity"]["accounts"][0]
        ["freshnessEvidence"]["expiresAt"] = json!("2026-09-08T09:00:00Z");
    let changed_attestation = verify(verify_request(
        planned,
        changed_attestation,
        "preconditions",
    ));
    assert_eq!(changed_attestation["reason"], "evidence_changed");

    let mut changed_resolution = evidence_projection_request();
    let resolution_plan = plan(changed_resolution.clone());
    changed_resolution["resolvedEvidence"][1]["version"] = json!("fd-resolution/2");
    let changed_resolution = verify(verify_request(
        resolution_plan,
        changed_resolution,
        "preconditions",
    ));
    assert_eq!(changed_resolution["reason"], "evidence_changed");
}

#[test]
fn postconditions_allow_only_invalidated_supplemental_facts_for_mutated_accounts() {
    let mut manual = request();
    fund_food(&mut manual, 2_000);
    manual["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-2_000, "USD"), vec![]
    )});
    add_legacy_account_from_current_ledger(&mut manual, "checking");
    recapture_actual_source(&mut manual, "2026-09-06T10:00:00Z");
    set_actual_base_balance_evidence(&mut manual, "checking", "2026-09-06T10:00:00Z");
    add_user_attested_flow_and_obligation(&mut manual, "checking");
    let manual_plan = plan(manual.clone());
    assert_eq!(
        manual_plan["source"]["manualPayeeBindings"],
        json!([{
            "parentId": "manual-parent-1",
            "payeeName": "Local shop",
            "existingPayeeId": null
        }])
    );
    assert_eq!(
        manual_plan["source"]["invalidatedFreshnessAccounts"],
        json!(["checking"])
    );
    assert_eq!(
        manual_plan["source"]["invalidatedSupplementalFacts"],
        json!([{
            "accountId": "checking",
            "fields": ["currency", "kind", "owned", "currentLedgerConfirmed", "holds", "unsettledFlows", "obligations"],
            "paths": [
                "currency", "currencyEvidence", "kind", "kindEvidence", "owned",
                "ownershipEvidence", "freshnessEvidence", "holds", "holdsEvidence",
                "activityEvidence", "scheduleEvidence"
            ],
            "flowIds": ["supplemental-flow-checking"],
            "obligationIds": ["supplemental-obligation-checking"]
        }])
    );
    let transaction = manual["intent"]["transaction"].clone();
    apply_manual_postconditions(&mut manual, &transaction, 11_000, 0);
    set_legacy_account_balance(&mut manual, "checking", money(11_000, "USD"));
    manual["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": transaction["parentId"], "accountId": transaction["accountId"],
            "date": transaction["date"], "payeeId": "actual-payee-local-shop",
            "payeeName": transaction["payeeName"],
            "categoryId": transaction["categoryId"], "categoryName": null,
            "amount": transaction["amount"], "cleared": false, "reconciled": false,
            "importedId": null, "importedPayee": null, "notes": transaction["notes"],
            "tags": [], "transferAccountId": null, "subtransactions": []
        }));
    manual["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "kind": "pending_activity",
            "scope": {"kind": "account", "id": "checking"},
            "state": "included",
            "observedAt": "2026-09-06T10:00:00Z",
            "evidence": [{
                "evidenceId": transaction["parentId"],
                "kind": "transaction",
                "authorized": true,
                "redaction": "visible"
            }]
        }));
    manual["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "actual-payee-local-shop", "name": "Local shop",
            "transferAccountId": null, "mtid": null
        }));
    recapture_actual_source(&mut manual, "2026-09-06T10:01:00Z");
    apply_actual_account_projection(&mut manual, "checking", "2026-09-06T10:01:00Z");
    let mut future_capture = manual.clone();
    future_capture["evaluatedAt"] = json!(EVALUATED_AT);
    assert_eq!(
        verify(verify_request(
            manual_plan.clone(),
            future_capture,
            "postconditions"
        ))["valid"],
        false,
        "future capture is refused even when human freshness was invalidated"
    );
    manual["evaluatedAt"] = json!("2026-09-06T10:01:00Z");
    assert_eq!(
        verify(verify_request(
            manual_plan.clone(),
            manual.clone(),
            "postconditions"
        ))["valid"],
        true,
        "a manual write may invalidate only its account's source-bound user freshness"
    );

    let mut existing_payee = request();
    fund_food(&mut existing_payee, 2_000);
    existing_payee["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-2_000, "USD"), vec![]
    )});
    existing_payee["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] =
        json!("complete");
    existing_payee["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"] = json!([{"id": "existing-payee-1", "name": "Local shop", "transferAccountId": null, "mtid": null}]);
    add_legacy_account_from_current_ledger(&mut existing_payee, "checking");
    recapture_actual_source(&mut existing_payee, "2026-09-06T10:00:00Z");
    set_actual_base_balance_evidence(&mut existing_payee, "checking", "2026-09-06T10:00:00Z");
    add_user_attested_flow_and_obligation(&mut existing_payee, "checking");
    let existing_payee_plan = plan(existing_payee.clone());
    assert_eq!(
        existing_payee_plan["source"]["manualPayeeBindings"],
        json!([{
            "parentId": "manual-parent-1",
            "payeeName": "Local shop",
            "existingPayeeId": "existing-payee-1"
        }])
    );
    let transaction = existing_payee["intent"]["transaction"].clone();
    apply_manual_postconditions(&mut existing_payee, &transaction, 11_000, 0);
    set_legacy_account_balance(&mut existing_payee, "checking", money(11_000, "USD"));
    existing_payee["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": transaction["parentId"], "accountId": transaction["accountId"],
            "date": transaction["date"], "payeeId": "existing-payee-1",
            "payeeName": transaction["payeeName"], "categoryId": transaction["categoryId"],
            "categoryName": null, "amount": transaction["amount"], "cleared": false,
            "reconciled": false, "importedId": null, "importedPayee": null,
            "notes": transaction["notes"], "tags": [], "transferAccountId": null,
            "subtransactions": []
        }));
    recapture_actual_source(&mut existing_payee, "2026-09-06T10:01:00Z");
    apply_actual_account_projection(&mut existing_payee, "checking", "2026-09-06T10:01:00Z");
    existing_payee["evaluatedAt"] = json!("2026-09-06T10:01:00Z");
    assert_eq!(
        verify(verify_request(
            existing_payee_plan,
            existing_payee,
            "postconditions"
        ))["valid"],
        true,
        "the exact existing source payee remains present after its transaction is written"
    );

    let mut changed_fallback = manual.clone();
    account_fact_mut(&mut changed_fallback, "checking")["freshnessEvidence"]["reasons"] =
        json!(["not-the-actual-fallback"]);
    let changed_fallback = verify(verify_request(
        manual_plan.clone(),
        changed_fallback,
        "postconditions",
    ));
    assert_eq!(changed_fallback["reason"], "source_changed");

    let mut changed_raw_record = manual.clone();
    changed_raw_record["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]
        ["transactions"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "unrelated-source-row", "accountId": "checking", "date": "2026-09-05",
            "payeeId": null, "payeeName": "Other", "categoryId": null, "categoryName": null,
            "amount": money(-1, "USD"), "cleared": false, "reconciled": false,
            "importedId": null, "importedPayee": null, "notes": null, "tags": [],
            "transferAccountId": null, "subtransactions": []
        }));
    changed_raw_record["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "unrelated-payee", "name": "Unrelated",
            "transferAccountId": null, "mtid": null
        }));
    let changed_raw_record = verify(verify_request(
        manual_plan.clone(),
        changed_raw_record,
        "postconditions",
    ));
    assert_eq!(changed_raw_record["reason"], "source_changed");

    let mut unrelated_edit = manual.clone();
    account_fact_mut(&mut unrelated_edit, "savings")["activityEvidence"]["reasons"] =
        json!(["unrelated-source-change"]);
    let unrelated_edit = verify(verify_request(
        manual_plan,
        unrelated_edit,
        "postconditions",
    ));
    assert_eq!(unrelated_edit["valid"], false);
    assert_eq!(unrelated_edit["reason"], "source_changed");

    let mut transfer = request();
    transfer["intent"] = json!({
        "kind": "transfer", "transferId": "ledger-transfer-1", "correlationId": "transfer-correlation-1",
        "sourceAccountId": "checking", "destinationAccountId": "savings",
        "amount": money(1_000, "USD"), "date": "2026-09-06"
    });
    add_legacy_account_from_current_ledger(&mut transfer, "checking");
    add_legacy_account_from_current_ledger(&mut transfer, "savings");
    recapture_actual_source(&mut transfer, "2026-09-06T10:00:00Z");
    set_actual_base_balance_evidence(&mut transfer, "checking", "2026-09-06T10:00:00Z");
    set_actual_base_balance_evidence(&mut transfer, "savings", "2026-09-06T10:00:00Z");
    add_user_attested_flow_and_obligation(&mut transfer, "checking");
    add_user_attested_flow_and_obligation(&mut transfer, "savings");
    let transfer_plan = plan(transfer.clone());
    assert_eq!(
        transfer_plan["source"]["invalidatedFreshnessAccounts"],
        json!(["checking", "savings"])
    );
    apply_transfer_postconditions(
        &mut transfer,
        "ledger-transfer-1",
        "transfer-correlation-1",
        true,
    );
    set_legacy_account_balance(&mut transfer, "checking", money(12_000, "USD"));
    set_legacy_account_balance(&mut transfer, "savings", money(21_000, "USD"));
    let marker = "balanceframe:transfer:ledger-transfer-1:transfer-correlation-1";
    transfer["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array_mut()
        .unwrap()
        .extend([
            json!({
                "id": "actual-transfer-source-1", "accountId": "checking",
                "date": "2026-09-06", "payeeId": null, "payeeName": null,
                "categoryId": null, "categoryName": null,
                "amount": money(-1_000, "USD"), "cleared": false, "reconciled": false,
                "importedId": null, "importedPayee": null, "notes": marker, "tags": [],
                "transferAccountId": "savings", "subtransactions": []
            }),
            json!({
                "id": "actual-transfer-destination-1", "accountId": "savings",
                "date": "2026-09-06", "payeeId": null, "payeeName": null,
                "categoryId": null, "categoryName": null,
                "amount": money(1_000, "USD"), "cleared": false, "reconciled": false,
                "importedId": null, "importedPayee": null, "notes": marker, "tags": [],
                "transferAccountId": "checking", "subtransactions": []
            }),
        ]);
    recapture_actual_source(&mut transfer, "2026-09-06T10:02:00Z");
    apply_actual_account_projection(&mut transfer, "checking", "2026-09-06T10:02:00Z");
    apply_actual_account_projection(&mut transfer, "savings", "2026-09-06T10:02:00Z");
    assert_eq!(
        verify(verify_request(
            transfer_plan.clone(),
            transfer.clone(),
            "postconditions"
        ))["valid"],
        true,
        "a transfer may invalidate current-ledger attestations for exactly both touched accounts"
    );
    let mut actual_unknown_facts = transfer;
    for account_id in ["checking", "savings"] {
        let account = account_fact_mut(&mut actual_unknown_facts, account_id);
        for path in [
            "currencyEvidence",
            "kindEvidence",
            "ownershipEvidence",
            "freshnessEvidence",
            "holdsEvidence",
        ] {
            account[path]["observedAt"] = Value::Null;
        }
    }
    assert_eq!(
        verify(verify_request(
            transfer_plan.clone(),
            actual_unknown_facts.clone(),
            "postconditions"
        ))["valid"],
        true,
        "Actual recapture may represent invalidated unknown facts without observation timestamps"
    );
    let mut older_unknown_fact = actual_unknown_facts;
    account_fact_mut(&mut older_unknown_fact, "checking")["freshnessEvidence"]["observedAt"] =
        json!("2026-09-06T09:59:00Z");
    let changed_unknown_fact = verify(verify_request(
        transfer_plan,
        older_unknown_fact,
        "postconditions",
    ));
    assert_eq!(changed_unknown_fact["valid"], false);
    assert_eq!(changed_unknown_fact["reason"], "source_changed");
}

fn shared_new_payee_readback(before: &str) -> (Value, Value) {
    let mut input = request();
    input["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!(before);
    fund_food(&mut input, 2_000);
    input["decisionCardRequest"]["financialSnapshot"]["coverage"]["transactions"] = json!("empty");
    let first = manual_transaction(money(-1_000, "USD"), vec![]);
    let mut second = manual_transaction(money(-1_000, "USD"), vec![]);
    second["parentId"] = json!("manual-parent-2");
    second["correlationId"] = json!("manual-correlation-2");
    input["intent"] = json!({
        "kind": "composite",
        "actions": [
            {"kind": "manual_transaction", "transaction": first.clone()},
            {"kind": "manual_transaction", "transaction": second.clone()}
        ]
    });
    add_legacy_account_from_current_ledger(&mut input, "checking");
    recapture_actual_source(&mut input, "2026-09-06T10:00:00Z");
    set_actual_base_balance_evidence(&mut input, "checking", "2026-09-06T10:00:00Z");
    add_user_attested_flow_and_obligation(&mut input, "checking");
    let planned = plan(input.clone());
    assert_eq!(planned["source"]["transactionsCoverageBefore"], "empty");
    assert_eq!(
        planned["source"]["manualPayeeBindings"],
        json!([
            {"parentId": "manual-parent-1", "payeeName": "Local shop", "existingPayeeId": null},
            {"parentId": "manual-parent-2", "payeeName": "Local shop", "existingPayeeId": null}
        ])
    );

    apply_manual_postconditions(&mut input, &first, 12_000, 1_000);
    apply_manual_postconditions(&mut input, &second, 11_000, 0);
    set_legacy_account_balance(&mut input, "checking", money(11_000, "USD"));
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"]
        .as_array_mut()
        .unwrap()
        .extend([
            json!({
                "id": "manual-parent-1", "accountId": "checking", "date": "2026-09-06",
                "payeeId": "actual-payee-local-shop", "payeeName": "Local shop",
                "categoryId": "food", "categoryName": null, "amount": money(-1_000, "USD"),
                "cleared": false, "reconciled": false, "importedId": null, "importedPayee": null,
                "notes": null, "tags": [], "transferAccountId": null, "subtransactions": []
            }),
            json!({
                "id": "manual-parent-2", "accountId": "checking", "date": "2026-09-06",
                "payeeId": "actual-payee-local-shop", "payeeName": "Local shop",
                "categoryId": "food", "categoryName": null, "amount": money(-1_000, "USD"),
                "cleared": false, "reconciled": false, "importedId": null, "importedPayee": null,
                "notes": null, "tags": [], "transferAccountId": null, "subtransactions": []
            }),
        ]);
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "actual-payee-local-shop",
            "name": "Local shop",
            "transferAccountId": null,
            "mtid": null
        }));
    input["decisionCardRequest"]["financialSnapshot"]["coverage"]["transactions"] =
        json!("complete");
    input["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!("complete");
    let observations = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap();
    for transaction_id in ["manual-parent-1", "manual-parent-2"] {
        observations.push(json!({
            "kind": "pending_activity",
            "scope": {"kind": "account", "id": "checking"},
            "state": "included",
            "observedAt": "2026-09-06T10:01:00Z",
            "evidence": [{
                "evidenceId": transaction_id,
                "kind": "transaction",
                "authorized": true,
                "redaction": "visible"
            }]
        }));
    }
    recapture_actual_source(&mut input, "2026-09-06T10:01:00Z");
    apply_actual_account_projection(&mut input, "checking", "2026-09-06T10:01:00Z");
    (planned, input)
}

#[test]
fn readback_reverses_first_transaction_coverage_and_shared_new_payee_once() {
    for before in ["empty", "complete"] {
        let (planned, input) = shared_new_payee_readback(before);
        assert_eq!(
            verify(verify_request(planned.clone(), input.clone(), "postconditions"))["valid"],
            true,
            "readback removes only both action-created observations and restores the empty coverage"
        );
        for coverage in ["unknown", "partial", "unavailable"] {
            let mut changed = input.clone();
            changed["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] =
                json!(coverage);
            assert_eq!(
                verify(verify_request(planned.clone(), changed, "postconditions"))["valid"],
                false
            );
        }
        let mut changed = input.clone();
        changed["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"]
            .as_array_mut()
            .unwrap()
            .push(json!({
                "id": "unrelated-payee", "name": "Other", "transferAccountId": null, "mtid": null
            }));
        assert_eq!(
            verify(verify_request(planned, changed, "postconditions"))["valid"],
            false
        );
    }
}

#[test]
fn wallet_readback_removes_only_its_generated_account_observations() {
    let mut input = request();
    input["intent"] = json!({
        "kind": "wallet_materialization",
        "walletId": "wallet-new-1",
        "accountName": "Emergency savings",
        "currency": "USD"
    });
    input["decisionCardRequest"]["financialSnapshot"]["coverage"]["accounts"] = json!("empty");
    input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "kind": "account_collection_coverage",
            "scope": {"kind": "global"},
            "state": "complete",
            "observedAt": EVALUATED_AT,
            "evidence": []
        }));
    recapture_actual_source(&mut input, "2026-09-06T10:00:00Z");
    input["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!("empty");
    let planned = plan(input.clone());
    assert_eq!(planned["source"]["accountsCoverageBefore"], "empty");
    let account_id = "actual-wallet-account-1";
    apply_wallet_postconditions(&mut input, true);
    input["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!("complete");
    input["decisionCardRequest"]["financialSnapshot"]["coverage"]["accounts"] = json!("complete");
    input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .extend([
            json!({
                "kind": "account_coverage",
                "scope": {"kind": "account", "id": account_id},
                "state": "complete",
                "observedAt": "2026-09-06T10:01:00Z",
                "evidence": [{
                    "evidenceId": account_id,
                    "kind": "account",
                    "authorized": true,
                    "redaction": "visible"
                }]
            }),
            json!({
                "kind": "account_balance",
                "scope": {"kind": "account", "id": account_id},
                "state": "complete",
                "observedAt": "2026-09-06T10:01:00Z",
                "evidence": [{
                    "evidenceId": account_id,
                    "kind": "account",
                    "authorized": true,
                    "redaction": "visible"
                }]
            }),
        ]);
    for (kind, state, observed_at) in [
        ("account_freshness", "unknown", Value::Null),
        ("account_type", "complete", json!("2026-09-06T10:01:00Z")),
        (
            "credit_card_obligation_coverage",
            "unavailable",
            Value::Null,
        ),
    ] {
        let mut observation = json!({
            "kind": kind, "scope": {"kind": "account", "id": account_id}, "state": state,
            "evidence": [{"evidenceId": account_id, "kind": "account", "authorized": true, "redaction": "visible"}]
        });
        if !observed_at.is_null() {
            observation["observedAt"] = observed_at;
        }
        input["decisionCardRequest"]["financialSnapshot"]["observations"]
            .as_array_mut()
            .unwrap()
            .push(observation);
    }
    recapture_actual_source(&mut input, "2026-09-06T10:01:00Z");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            input.clone(),
            "postconditions"
        ))["valid"],
        true,
        "wallet observations are removed by exact generated-account scope"
    );
    let mut duplicated = input.clone();
    let duplicate = duplicated["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    duplicated["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            duplicated,
            "postconditions"
        ))["valid"],
        false
    );
    for coverage in ["unknown", "partial", "unavailable"] {
        let mut changed = input.clone();
        changed["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!(coverage);
        assert_eq!(
            verify(verify_request(planned.clone(), changed, "postconditions"))["valid"],
            false
        );
    }
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array_mut()
        .unwrap()
        .push(json!({
            "id": "unrelated-payee", "name": "Other", "transferAccountId": null, "mtid": null
        }));
    assert_eq!(
        verify(verify_request(planned, input, "postconditions"))["valid"],
        false
    );
}

#[test]
fn transfer_dispatch_preconditions_use_authorized_prior_atom_balances() {
    let mut input = request();
    fund_food(&mut input, 2_000);
    input["decisionCardRequest"]["items"][0]["amount"] = money(500, "USD");
    let transaction = manual_transaction(money(-500, "USD"), vec![]);
    input["intent"] = json!({
        "kind": "composite",
        "actions": [
            {"kind": "manual_transaction", "transaction": transaction},
            {
                "kind": "transfer",
                "transferId": "ledger-transfer-after-manual",
                "correlationId": "transfer-correlation-after-manual",
                "sourceAccountId": "checking",
                "destinationAccountId": "savings",
                "amount": money(500, "USD"),
                "date": "2026-09-06"
            }
        ]
    });
    let planned = plan(input.clone());
    assert_eq!(
        planned["dispatchPreconditions"],
        json!([{
            "atomIndex": 1,
            "accountBalances": [
                {"accountId": "checking", "balance": money(12_500, "USD")},
                {"accountId": "savings", "balance": money(20_000, "USD")}
            ],
            "assignments": []
        }])
    );

    let mut tampered = planned;
    tampered["dispatchPreconditions"][0]["accountBalances"][0]["balance"] = money(13_000, "USD");
    assert_eq!(
        verify(verify_request(tampered, input, "preconditions"))["reason"],
        "invalid_plan",
        "ordered dispatch balances are action-hash bound"
    );
}

#[test]
fn reallocation_dispatch_preconditions_bind_unique_assignment_targets() {
    let mut input = request();
    input["decisionCardRequest"]["categoryPolicies"][2]["donorEligible"] = json!(true);
    category_fact_mut(&mut input, "reserve")["availability"] = money(4_000, "USD");
    input["intent"]["assignments"] = json!([
        {
            "sourceCategoryId": "reserve",
            "sourceAsOfMonth": "2026-09",
            "destinationCategoryId": "food",
            "destinationAsOfMonth": "2026-09",
            "amount": money(1_000, "USD")
        },
        {
            "sourceCategoryId": "reserve-two",
            "sourceAsOfMonth": "2026-09",
            "destinationCategoryId": "food",
            "destinationAsOfMonth": "2026-09",
            "amount": money(1_000, "USD")
        }
    ]);
    let planned = plan(input.clone());
    assert_eq!(
        planned["dispatchPreconditions"][0]["assignments"],
        json!([
            {
                "categoryId": "food",
                "asOfMonth": "2026-09",
                "amount": money(0, "USD"),
                "postAmount": money(2_000, "USD")
            },
            {
                "categoryId": "reserve",
                "asOfMonth": "2026-09",
                "amount": money(6_000, "USD"),
                "postAmount": money(5_000, "USD")
            },
            {
                "categoryId": "reserve-two",
                "asOfMonth": "2026-09",
                "amount": money(6_000, "USD"),
                "postAmount": money(5_000, "USD")
            }
        ])
    );
    let mut tampered = planned.clone();
    tampered["dispatchPreconditions"][0]["assignments"][0]["postAmount"] = money(9_999, "USD");
    assert_eq!(
        verify(verify_request(tampered, input, "preconditions"))["reason"],
        "invalid_plan",
        "post-state dispatch values are action-hash bound"
    );
}

#[test]
fn reallocation_dispatch_post_amounts_follow_each_ordered_atom() {
    let mut input = request();
    input["decisionCardRequest"]["categoryPolicies"][2]["donorEligible"] = json!(true);
    category_fact_mut(&mut input, "reserve")["availability"] = money(4_000, "USD");
    input["intent"] = json!({
        "kind": "composite",
        "actions": [
            {
                "kind": "reallocation",
                "assignments": [{
                    "sourceCategoryId": "reserve",
                    "sourceAsOfMonth": "2026-09",
                    "destinationCategoryId": "food",
                    "destinationAsOfMonth": "2026-09",
                    "amount": money(1_000, "USD")
                }]
            },
            {
                "kind": "reallocation",
                "assignments": [{
                    "sourceCategoryId": "reserve-two",
                    "sourceAsOfMonth": "2026-09",
                    "destinationCategoryId": "food",
                    "destinationAsOfMonth": "2026-09",
                    "amount": money(1_000, "USD")
                }]
            }
        ]
    });

    let planned = plan(input);
    let dispatches = planned["dispatchPreconditions"].as_array().unwrap();
    assert_eq!(dispatches.len(), 2);
    assert_eq!(dispatches[0]["atomIndex"], 0);
    assert_eq!(
        dispatches[0]["assignments"],
        json!([
            {
                "categoryId": "food",
                "asOfMonth": "2026-09",
                "amount": money(0, "USD"),
                "postAmount": money(1_000, "USD")
            },
            {
                "categoryId": "reserve",
                "asOfMonth": "2026-09",
                "amount": money(6_000, "USD"),
                "postAmount": money(5_000, "USD")
            }
        ])
    );
    assert_eq!(dispatches[1]["atomIndex"], 1);
    assert_eq!(
        dispatches[1]["assignments"],
        json!([
            {
                "categoryId": "food",
                "asOfMonth": "2026-09",
                "amount": money(1_000, "USD"),
                "postAmount": money(2_000, "USD")
            },
            {
                "categoryId": "reserve-two",
                "asOfMonth": "2026-09",
                "amount": money(6_000, "USD"),
                "postAmount": money(5_000, "USD")
            }
        ])
    );
}

#[test]
fn rollover_surplus_can_be_reallocated_beyond_current_month_assignment() {
    let mut input = request();
    assignment_mut(&mut input, "reserve")["amount"] = money(0, "USD");

    let planned =
        plan_request(input).expect("positive rollover availability may exceed assignment");
    assert!(
        planned["expectedPostconditions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|condition| {
                condition["kind"] == "assignment"
                    && condition["categoryId"] == "reserve"
                    && condition["amount"] == money(-2_000, "USD")
            }),
        "the exact assignment delta remains checked even when it becomes negative"
    );
}

#[test]
fn postconditions_verify_each_atom_and_the_ordered_composite() {
    let mut manual = request();
    fund_food(&mut manual, 2_000);
    manual["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(
        money(-2_000, "USD"), vec![]
    )});
    let manual_plan = plan(manual.clone());
    let manual_intent = manual["intent"]["transaction"].clone();
    apply_manual_postconditions(&mut manual, &manual_intent, 11_000, 0);
    assert_eq!(
        verify(verify_request(manual_plan, manual, "postconditions"))["valid"],
        true,
        "manual transaction verifies its exact row and account/category effects"
    );

    let mut projection = evidence_projection_request();
    let projection_plan = plan(projection.clone());
    let projection_intent = projection["intent"]["transaction"].clone();
    apply_manual_postconditions(&mut projection, &projection_intent, 12_500, 1_500);
    assert_eq!(
        verify(verify_request(
            projection_plan,
            projection,
            "postconditions"
        ))["valid"],
        true,
        "evidence projection reuses exact manual postconditions and evidence identity"
    );

    let mut wallet = request();
    wallet["intent"] = json!({
        "kind": "wallet_materialization", "walletId": "wallet-new-1",
        "accountName": "Emergency savings", "currency": "USD"
    });
    wallet["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!("complete");
    wallet["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"] = json!([{"id": "existing-payee-1", "name": "Household", "transferAccountId": null, "mtid": null}]);
    let wallet_plan = plan(wallet.clone());
    apply_wallet_postconditions(&mut wallet, true);
    assert_eq!(
        verify(verify_request(
            wallet_plan.clone(),
            wallet.clone(),
            "postconditions"
        ))["valid"],
        true,
        "wallet verification follows the durable wallet ID to the generated account ID"
    );
    wallet["currentLedger"]["wallets"] = json!([]);
    let name_only = verify(verify_request(wallet_plan, wallet, "postconditions"));
    assert_eq!(
        name_only["valid"], false,
        "same-name recovery without a durable identity map is refused"
    );

    let mut transfer = request();
    transfer["intent"] = json!({
        "kind": "transfer", "transferId": "ledger-transfer-1", "correlationId": "transfer-correlation-1",
        "sourceAccountId": "checking", "destinationAccountId": "savings",
        "amount": money(1_000, "USD"), "date": "2026-09-06"
    });
    let transfer_plan = plan(transfer.clone());
    apply_transfer_postconditions(
        &mut transfer,
        "ledger-transfer-1",
        "transfer-correlation-1",
        true,
    );
    assert_eq!(
        verify(verify_request(
            transfer_plan.clone(),
            transfer.clone(),
            "postconditions"
        ))["valid"],
        true,
        "transfer verification requires the exact stable mapped reciprocal ledger pair"
    );
    apply_transfer_postconditions(
        &mut transfer,
        "ledger-transfer-1",
        "transfer-correlation-1",
        false,
    );
    let unlinked_pair = verify(verify_request(transfer_plan, transfer, "postconditions"));
    assert_eq!(
        unlinked_pair["valid"], false,
        "equal/opposite rows without reciprocal links do not prove a transfer"
    );

    let mut composite = request();
    composite["intent"] = fixture(ACTION_FIXTURE)["compositeIntent"].clone();
    let composite_plan = plan(composite.clone());
    apply_fixture_postconditions(&mut composite, "composite");
    let combined = verify(verify_request(composite_plan, composite, "postconditions"));
    assert_eq!(
        combined["valid"], true,
        "composite verifier reverses authorized effects in reverse atom order"
    );
}

#[test]
fn manual_actions_are_bounded_by_trusted_cart_and_aggregate_charges() {
    let mut over_cart = request();
    fund_food(&mut over_cart, 5_000);
    over_cart["intent"] = json!({
        "kind": "manual_transaction",
        "transaction": manual_transaction(money(-2_500, "USD"), vec![])
    });
    assert!(
        plan_request(over_cart).is_err(),
        "manual debits cannot exceed the trusted account, category, or cart charge"
    );

    let mut wrong_category = request();
    wrong_category["intent"] = json!({
        "kind": "manual_transaction",
        "transaction": {
            "parentId": "manual-parent-1",
            "correlationId": "manual-correlation-1",
            "accountId": "checking",
            "amount": money(-1_000, "USD"),
            "date": "2026-09-06",
            "categoryId": "reserve",
            "payeeName": "Local shop",
            "notes": null,
            "splits": []
        }
    });
    assert!(
        plan_request(wrong_category).is_err(),
        "a valid ledger category is not enough when the trusted card charges another category"
    );

    let mut wrong_account = request();
    wrong_account["intent"] = json!({
        "kind": "manual_transaction",
        "transaction": {
            "parentId": "manual-parent-1",
            "correlationId": "manual-correlation-1",
            "accountId": "savings",
            "amount": money(-1_000, "USD"),
            "date": "2026-09-06",
            "categoryId": "food",
            "payeeName": "Local shop",
            "notes": null,
            "splits": []
        }
    });
    assert!(
        plan_request(wrong_account).is_err(),
        "manual debits must use an account charged by the trusted card"
    );

    let mut wrong_split = request();
    wrong_split["intent"] = json!({
        "kind": "manual_transaction",
        "transaction": manual_transaction(
            money(-1_000, "USD"),
            vec![
                json!({"categoryId": "food", "amount": money(-500, "USD")}),
                json!({"categoryId": "reserve", "amount": money(-500, "USD")})
            ]
        )
    });
    assert!(
        plan_request(wrong_split).is_err(),
        "split children must fit their respective trusted category charges"
    );

    let mut duplicate_correlation = request();
    fund_food(&mut duplicate_correlation, 2_000);
    duplicate_correlation["intent"] = json!({
        "kind": "composite",
        "actions": [
            {"kind": "manual_transaction", "transaction": manual_transaction(money(-1_000, "USD"), vec![])},
            {"kind": "manual_transaction", "transaction": {
                "parentId": "manual-parent-2",
                "correlationId": "manual-correlation-1",
                "accountId": "checking",
                "amount": money(-1_000, "USD"),
                "date": "2026-09-06",
                "categoryId": "food",
                "payeeName": "Local shop",
                "notes": null,
                "splits": []
            }}
        ]
    });
    assert!(
        plan_request(duplicate_correlation).is_err(),
        "composite manual effects require distinct parent and correlation identities"
    );

    let mut aggregate_over_cart = request();
    fund_food(&mut aggregate_over_cart, 5_000);
    aggregate_over_cart["intent"] = json!({
        "kind": "composite",
        "actions": [
            {"kind": "manual_transaction", "transaction": manual_transaction(money(-1_500, "USD"), vec![])},
            {"kind": "manual_transaction", "transaction": {
                "parentId": "manual-parent-2",
                "correlationId": "manual-correlation-2",
                "accountId": "checking",
                "amount": money(-1_500, "USD"),
                "date": "2026-09-06",
                "categoryId": "food",
                "payeeName": "Local shop",
                "notes": null,
                "splits": []
            }}
        ]
    });
    assert!(
        plan_request(aggregate_over_cart).is_err(),
        "individually compatible atoms cannot exceed aggregate trusted cart money"
    );
}

#[test]
fn composite_manual_and_transfer_outflows_preserve_the_protected_buffer() {
    let transfer = json!({
        "kind": "transfer", "transferId": "ledger-transfer-composite-1",
        "correlationId": "transfer-correlation-composite-1", "sourceAccountId": "checking",
        "destinationAccountId": "savings", "amount": money(2_500, "USD"),
        "date": "2026-09-06"
    });
    let manual = json!({
        "kind": "manual_transaction",
        "transaction": manual_transaction(money(-2_000, "USD"), vec![])
    });
    for actions in [
        vec![transfer.clone(), manual.clone()],
        vec![manual, transfer],
    ] {
        let mut input = request();
        fund_food(&mut input, 2_000);
        input["intent"] = json!({"kind": "composite", "actions": actions});
        assert_eq!(
            plan_request(input).expect_err("composite outflows cannot consume a protected buffer"),
            "transfer_capacity_insufficient"
        );
    }
}

#[test]
fn consequential_action_rejects_reused_identities_and_unknown_source_metadata() {
    let mut duplicate_parent = request();
    fund_food(&mut duplicate_parent, 2_000);
    duplicate_parent["intent"] = json!({
        "kind": "composite",
        "actions": [
            {"kind": "manual_transaction", "transaction": manual_transaction(money(-1_000, "USD"), vec![])},
            {"kind": "manual_transaction", "transaction": {
                "parentId": "manual-parent-1",
                "correlationId": "manual-correlation-2",
                "accountId": "checking",
                "amount": money(-1_000, "USD"),
                "date": "2026-09-06",
                "categoryId": "food",
                "payeeName": "Local shop",
                "notes": null,
                "splits": []
            }}
        ]
    });
    assert!(
        plan_request(duplicate_parent).is_err(),
        "composite transaction parent IDs must be unique"
    );

    let mut duplicate_wallet = request();
    duplicate_wallet["currentLedger"]["wallets"] =
        json!([{"walletId": "wallet-new-1", "accountId": "savings"}]);
    duplicate_wallet["intent"] = json!({
        "kind": "wallet_materialization", "walletId": "wallet-new-1",
        "accountName": "Emergency savings", "currency": "USD"
    });
    assert!(
        plan_request(duplicate_wallet).is_err(),
        "a durable wallet mapping cannot be reused"
    );

    let mut duplicate_transfer = request();
    apply_transfer_postconditions(
        &mut duplicate_transfer,
        "ledger-transfer-1",
        "existing-transfer-correlation",
        true,
    );
    duplicate_transfer["intent"] = json!({
        "kind": "transfer", "transferId": "ledger-transfer-1", "correlationId": "new-transfer-correlation",
        "sourceAccountId": "checking", "destinationAccountId": "savings",
        "amount": money(1_000, "USD"), "date": "2026-09-06"
    });
    assert_eq!(
        plan_request(duplicate_transfer).expect_err("existing transfer IDs cannot be reused"),
        "invalid_transfer_intent"
    );

    let mut transfer_manual_collision = request();
    fund_food(&mut transfer_manual_collision, 2_000);
    transfer_manual_collision["intent"] = json!({
        "kind": "composite",
        "actions": [
            {
                "kind": "transfer", "transferId": "ledger-transfer-new-1",
                "correlationId": "manual-correlation-1", "sourceAccountId": "checking",
                "destinationAccountId": "savings", "amount": money(1_000, "USD"),
                "date": "2026-09-06"
            },
            {
                "kind": "manual_transaction",
                "transaction": manual_transaction(money(-2_000, "USD"), vec![])
            }
        ]
    });
    assert_eq!(
        plan_request(transfer_manual_collision)
            .expect_err("manual and transfer correlations share one identity namespace"),
        "invalid_or_duplicate_manual_transaction"
    );

    let mut duplicate_event_reference = evidence_projection_request();
    let mut repeated = duplicate_event_reference["decisionCardRequest"]["financialSnapshot"]
        ["observations"][1]
        .clone();
    repeated["scope"]["id"] = json!("another-economic-event");
    duplicate_event_reference["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(repeated);
    assert!(
        plan_request(duplicate_event_reference).is_err(),
        "economic-event evidence IDs cannot identify multiple resolution subjects"
    );

    let mut unknown_snapshot_field = request();
    unknown_snapshot_field["decisionCardRequest"]["financialSnapshot"]["unexpected"] = json!(true);
    assert!(
        plan_request(unknown_snapshot_field).is_err(),
        "Rust snapshot deserialization follows the strict public source schema"
    );
}

#[test]
fn postcondition_inverses_preserve_unrelated_current_ledger_edits() {
    let mut manual = request();
    fund_food(&mut manual, 2_000);
    manual["intent"] = json!({
        "kind": "manual_transaction",
        "transaction": manual_transaction(money(-2_000, "USD"), vec![])
    });
    let manual_plan = plan(manual.clone());
    let transaction = manual["intent"]["transaction"].clone();
    apply_manual_postconditions(&mut manual, &transaction, 11_000, 0);
    ledger_account_mut(&mut manual, "checking")["name"] = json!("Externally renamed");
    let manual_result = verify(verify_request(manual_plan, manual, "postconditions"));
    assert_eq!(manual_result["valid"], false);
    assert_eq!(manual_result["reason"], "source_changed");

    let mut reallocation = request();
    let reallocation_plan = plan(reallocation.clone());
    apply_reallocation_postconditions(&mut reallocation);
    ledger_account_mut(&mut reallocation, "checking")["name"] = json!("Externally renamed");
    let reallocation_result = verify(verify_request(
        reallocation_plan,
        reallocation,
        "postconditions",
    ));
    assert_eq!(reallocation_result["valid"], false);
    assert_eq!(reallocation_result["reason"], "source_changed");

    let mut composite = request();
    composite["intent"] = fixture(ACTION_FIXTURE)["compositeIntent"].clone();
    let composite_plan = plan(composite.clone());
    apply_fixture_postconditions(&mut composite, "composite");
    ledger_account_mut(&mut composite, "checking")["name"] = json!("Externally renamed");
    let composite_result = verify(verify_request(composite_plan, composite, "postconditions"));
    assert_eq!(composite_result["valid"], false);
    assert_eq!(composite_result["reason"], "source_changed");

    let mut wallet = request();
    wallet["intent"] = json!({
        "kind": "wallet_materialization", "walletId": "wallet-new-1",
        "accountName": "Emergency savings", "currency": "USD"
    });
    let wallet_plan = plan(wallet.clone());
    apply_wallet_postconditions(&mut wallet, true);
    ledger_account_mut(&mut wallet, "checking")["name"] = json!("Externally renamed");
    let wallet_result = verify(verify_request(wallet_plan, wallet, "postconditions"));
    assert_eq!(wallet_result["valid"], false);
    assert_eq!(wallet_result["reason"], "source_changed");

    let mut transfer = request();
    transfer["intent"] = json!({
        "kind": "transfer", "transferId": "ledger-transfer-1", "correlationId": "transfer-correlation-1",
        "sourceAccountId": "checking", "destinationAccountId": "savings",
        "amount": money(1_000, "USD"), "date": "2026-09-06"
    });
    let transfer_plan = plan(transfer.clone());
    apply_transfer_postconditions(
        &mut transfer,
        "ledger-transfer-1",
        "transfer-correlation-1",
        true,
    );
    ledger_account_mut(&mut transfer, "savings")["name"] = json!("Externally renamed");
    let transfer_result = verify(verify_request(transfer_plan, transfer, "postconditions"));
    assert_eq!(transfer_result["valid"], false);
    assert_eq!(transfer_result["reason"], "source_changed");
}

#[test]
fn currency_capture_clock_is_normalized_only_for_generated_actual_observations() {
    let mut input = request();
    recapture_actual_source(&mut input, EVALUATED_AT);
    let observations = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap();
    let index = observations.len();
    observations.push(json!({
        "kind": "currency_compatibility", "scope": {"kind": "global"},
        "state": "complete", "observedAt": EVALUATED_AT, "evidence": []
    }));
    let planned = plan(input.clone());
    recapture_actual_source(&mut input, "2026-09-06T10:01:00Z");
    input["decisionCardRequest"]["financialSnapshot"]["observations"][index]["observedAt"] =
        json!("2026-09-06T10:01:00Z");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            input.clone(),
            "preconditions"
        ))["valid"],
        true
    );
    for (field, value) in [
        ("observedAt", json!("2026-09-06T09:30:00Z")),
        ("state", json!("unknown")),
        ("contentHash", json!("changed-source")),
        (
            "evidence",
            json!([{
                "evidenceId": "external", "kind": "currency", "authorized": true, "redaction": "visible"
            }]),
        ),
    ] {
        let mut changed = input.clone();
        changed["decisionCardRequest"]["financialSnapshot"]["observations"][index][field] = value;
        assert_eq!(
            verify(verify_request(planned.clone(), changed, "preconditions"))["valid"],
            false
        );
    }
    input["currentLedger"]["accounts"][0]["currency"] = json!("EUR");
    assert_eq!(
        verify(verify_request(planned, input, "preconditions"))["valid"],
        false
    );
}

fn immediate_manual_request(kind: &str) -> Value {
    let mut input = if kind == "evidence" {
        evidence_projection_request()
    } else {
        request()
    };
    fund_food(&mut input, 2_000);
    if kind != "evidence" {
        let splits = if kind == "split" {
            vec![
                json!({"categoryId": "food", "amount": money(-1_000, "USD")}),
                json!({"categoryId": "food", "amount": money(-1_000, "USD")}),
            ]
        } else {
            vec![]
        };
        input["intent"] = json!({"kind": "manual_transaction", "transaction": manual_transaction(money(-2_000, "USD"), splits)});
    }
    let transaction = input["intent"]["transaction"].clone();
    let template = input["decisionCardRequest"]["items"][0].clone();
    let effects = if kind == "split" {
        transaction["splits"].as_array().unwrap().clone()
    } else {
        vec![transaction.clone()]
    };
    input["decisionCardRequest"]["items"] = Value::Array(effects.iter().enumerate().map(|(index, effect)| {
        let mut item = template.clone();
        item["id"] = if kind == "split" { json!(format!("{}:split:{index}", transaction["parentId"].as_str().unwrap())) } else { transaction["parentId"].clone() };
        item["categoryId"] = effect["categoryId"].clone();
        item["amount"] = money(-effect["amount"]["minorUnits"].as_str().unwrap().parse::<i64>().unwrap(), "USD");
        item["purchaseAt"] = json!(EVALUATED_AT);
        item["requiredBy"] = json!(EVALUATED_AT);
        item["routeSelection"] = json!({"explicitAccountId": "checking", "sessionAccountId": null, "approvedPreference": null, "historicalRoute": null});
        item
    }).collect());
    input["decisionCardRequest"]["context"]["horizon"]["startsAt"] = json!(EVALUATED_AT);
    input
}

#[test]
fn immediate_manual_debits_survive_approval_delay_without_retiming_source() {
    for kind in ["single", "split", "evidence"] {
        let mut input = immediate_manual_request(kind);
        let planned = plan(input.clone());
        input["evaluatedAt"] = json!("2026-09-06T10:00:07Z");
        input["decisionCardRequest"]["context"]["evaluatedAt"] = input["evaluatedAt"].clone();
        assert_eq!(
            verify(verify_request(
                planned.clone(),
                input.clone(),
                "preconditions"
            ))["valid"],
            true,
            "{kind}"
        );
        assert_eq!(
            plan(input.clone()),
            planned,
            "{kind}: source hash is unchanged"
        );
        assert_eq!(
            input["decisionCardRequest"]["items"][0]["purchaseAt"],
            EVALUATED_AT
        );
        for (change, reason) in [
            ("amount", "source_changed"),
            ("account", "source_changed"),
            ("claims", "claims_changed"),
            ("expired", "expired"),
            ("stale", "evidence_changed"),
            ("source", "source_changed"),
        ] {
            let mut changed = input.clone();
            match change {
                "amount" => changed["decisionCardRequest"]["items"][0]["amount"] = money(1, "USD"),
                "account" => {
                    changed["decisionCardRequest"]["items"][0]["routeSelection"]
                        ["explicitAccountId"] = json!("savings")
                }
                "claims" => {
                    changed["decisionCardRequest"]["claimSet"]["revision"] = json!("changed")
                }
                "expired" => changed["evaluatedAt"] = planned["expiresAt"].clone(),
                "stale" => {
                    account_fact_mut(&mut changed, "checking")["freshnessEvidence"]["state"] =
                        json!("unknown")
                }
                "source" => {
                    ledger_account_mut(&mut changed, "checking")["name"] = json!("Changed checking")
                }
                _ => unreachable!(),
            }
            let result = verify(verify_request(planned.clone(), changed, "preconditions"));
            assert_eq!(result["valid"], false, "{kind}: {change}");
            assert_eq!(result["reason"], reason, "{kind}: {change}");
        }
    }
}

#[test]
fn approval_delay_does_not_retime_unrelated_or_scheduled_cart_items() {
    for mode in [
        "unrelated",
        "scheduled",
        "quantity",
        "allocations",
        "barcode",
        "price",
        "session",
        "history",
        "preference",
    ] {
        let mut input = immediate_manual_request("single");
        let item = &mut input["decisionCardRequest"]["items"][0];
        match mode {
            "unrelated" => item["id"] = json!("user-cart-item"),
            "scheduled" => {
                item["purchaseAt"] = json!("2026-09-06T10:00:03Z");
                item["requiredBy"] = json!("2026-09-06T10:00:03Z");
            }
            "quantity" => item["quantity"] = json!(1),
            "allocations" => {
                item["categoryAllocations"] =
                    json!([{"categoryId": "food", "amount": money(2_000, "USD")}])
            }
            "barcode" => item["barcode"] = json!("123456789"),
            "price" => {
                item["priceProvenance"] = json!({"kind": "current_session_manual", "observedAt": EVALUATED_AT, "estimate": false})
            }
            "session" => item["routeSelection"]["sessionAccountId"] = json!("checking"),
            "preference" => {
                item["routeSelection"]["approvedPreference"] =
                    json!({"accountId": "savings", "referenceId": "approved-route"})
            }
            "history" => {
                item["routeSelection"]["historicalRoute"] =
                    json!({"accountId": "savings", "referenceId": "prior-purchase"})
            }
            _ => unreachable!(),
        }
        let planned = plan(input.clone());
        if mode == "scheduled" {
            input["evaluatedAt"] = json!("2026-09-06T10:00:01Z");
            assert_eq!(
                verify(verify_request(
                    planned.clone(),
                    input.clone(),
                    "preconditions"
                ))["valid"],
                true
            );
        }
        input["evaluatedAt"] = json!("2026-09-06T10:00:07Z");
        assert_eq!(
            verify(verify_request(planned, input, "preconditions"))["valid"],
            matches!(mode, "history" | "preference"),
            "{mode}"
        );
    }
}

#[test]
fn approval_delay_keeps_current_evidence_expiry_clock() {
    for kind in ["single", "split", "evidence"] {
        let mut input = immediate_manual_request(kind);
        account_fact_mut(&mut input, "checking")["freshnessEvidence"]["expiresAt"] =
            json!("2026-09-06T10:00:05Z");
        let planned = plan(input.clone());
        input["evaluatedAt"] = json!("2026-09-06T10:00:04Z");
        assert_eq!(
            verify(verify_request(
                planned.clone(),
                input.clone(),
                "preconditions"
            ))["valid"],
            true,
            "{kind}: before evidence expiry"
        );
        input["evaluatedAt"] = json!("2026-09-06T10:00:05Z");
        let result = verify(verify_request(planned, input, "preconditions"));
        assert_eq!(result["valid"], false, "{kind}: at evidence expiry");
        assert_eq!(result["reason"], "evidence_changed", "{kind}");
    }
}

#[test]
fn approval_delay_does_not_cross_utc_date_even_before_proposal_expiry() {
    for kind in ["single", "split", "evidence"] {
        let mut input = immediate_manual_request(kind);
        let created_at = "2026-09-06T23:59:55Z";
        input["evaluatedAt"] = json!(created_at);
        input["decisionCardRequest"]["context"]["evaluatedAt"] = json!(created_at);
        input["decisionCardRequest"]["context"]["horizon"]["startsAt"] = json!(created_at);
        input["decisionCardRequest"]["financialSnapshot"]["capturedAt"] = json!(created_at);
        input["decisionCardRequest"]["liquidityPolicy"]["expiresAt"] =
            json!("2026-09-07T01:00:00Z");
        input["decisionCardRequest"]["validUntil"] = json!("2026-09-07T00:30:00Z");
        for item in input["decisionCardRequest"]["items"]
            .as_array_mut()
            .unwrap()
        {
            item["purchaseAt"] = json!(created_at);
            item["requiredBy"] = json!(created_at);
        }
        let planned = plan(input.clone());
        input["evaluatedAt"] = json!("2026-09-06T23:59:59Z");
        assert_eq!(
            verify(verify_request(
                planned.clone(),
                input.clone(),
                "preconditions"
            ))["valid"],
            true,
            "{kind}: same UTC date"
        );
        input["evaluatedAt"] = json!("2026-09-07T00:00:02Z");
        let result = verify(verify_request(planned, input, "preconditions"));
        assert_eq!(result["valid"], false, "{kind}: next UTC date");
        assert_eq!(
            result["reason"], "source_changed",
            "{kind}: proposal is still unexpired"
        );
    }
}

#[test]
fn approval_delay_does_not_retime_extra_unrelated_or_scheduled_items() {
    for kind in ["single", "split", "evidence"] {
        for scheduled in [false, true] {
            let mut input = immediate_manual_request(kind);
            fund_food(&mut input, 3_000);
            let mut extra = input["decisionCardRequest"]["items"][0].clone();
            extra["id"] = json!("extra-cart-item");
            extra["amount"] = money(500, "USD");
            let mut extra_transaction = manual_transaction(money(-500, "USD"), vec![]);
            extra_transaction["parentId"] = json!("extra-manual-parent");
            extra_transaction["correlationId"] = json!("extra-manual-correlation");
            input["intent"] = json!({"kind": "composite", "actions": [
                input["intent"].clone(),
                {"kind": "manual_transaction", "transaction": extra_transaction}
            ]});
            if scheduled {
                extra["id"] = json!("extra-manual-parent");
                extra["purchaseAt"] = json!("2026-09-06T10:00:03Z");
                extra["requiredBy"] = extra["purchaseAt"].clone();
            }
            input["decisionCardRequest"]["items"]
                .as_array_mut()
                .unwrap()
                .push(extra);
            let planned = plan(input.clone());
            if scheduled {
                input["evaluatedAt"] = json!("2026-09-06T10:00:01Z");
                assert_eq!(
                    verify(verify_request(
                        planned.clone(),
                        input.clone(),
                        "preconditions"
                    ))["valid"],
                    true,
                    "{kind}: scheduled item is still in the future"
                );
            }
            input["evaluatedAt"] = json!("2026-09-06T10:00:07Z");
            let result = verify(verify_request(planned, input, "preconditions"));
            assert_eq!(result["valid"], false, "{kind}: scheduled={scheduled}");
            assert_eq!(
                result["reason"], "source_changed",
                "{kind}: scheduled={scheduled}"
            );
        }
    }
}

#[test]
fn reallocation_cannot_authorize_a_purchase_that_still_needs_a_transfer() {
    let mut input = request();
    ledger_account_mut(&mut input, "checking")["balance"] = money(9_000, "USD");
    account_fact_mut(&mut input, "checking")["recordedBalance"] = money(9_000, "USD");
    assert_eq!(
        plan_request(input).unwrap_err(),
        "reallocation_not_safe_in_decision_card"
    );
}

#[test]
fn reallocation_readback_restores_legacy_budget_assignments_exactly() {
    let mut input = request();
    let mut categories = serde_json::Map::new();
    for (id, amount) in [("food", 0), ("reserve", 6_000), ("reserve-two", 6_000)] {
        categories.insert(id.into(), json!({"categoryId": id, "amount": money(amount, "USD"),
            "carryover": money(0, "USD"), "carryoverFromPrevious": money(0, "USD"), "carriesOver": false}));
    }
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["budgets"] =
        json!([{"id": "budget-september", "month": "2026-09", "categories": categories}]);
    let planned = plan(input.clone());
    apply_reallocation_postconditions(&mut input);
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["budgets"][0]
        ["categories"]["food"]["amount"] = money(2_000, "USD");
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["budgets"][0]
        ["categories"]["reserve"]["amount"] = money(4_000, "USD");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            input.clone(),
            "postconditions"
        ))["valid"],
        true
    );
    for change in ["amount", "currency", "duplicate", "missing"] {
        let mut changed = input.clone();
        let budgets =
            &mut changed["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["budgets"];
        match change {
            "amount" => budgets[0]["categories"]["reserve"]["amount"] = money(3_999, "USD"),
            "currency" => budgets[0]["categories"]["reserve"]["amount"] = money(4_000, "EUR"),
            "duplicate" => {
                let duplicate = budgets[0].clone();
                budgets.as_array_mut().unwrap().push(duplicate);
            }
            "missing" => {
                budgets[0]["categories"]
                    .as_object_mut()
                    .unwrap()
                    .remove("reserve");
            }
            _ => unreachable!(),
        }
        let result = verify(verify_request(planned.clone(), changed, "postconditions"));
        assert_eq!(result["valid"], false, "{change}");
        assert_eq!(result["reason"], "source_changed", "{change}");
    }
}

#[test]
fn resolved_split_evidence_requires_exact_checked_conservation() {
    let mut input = evidence_projection_request();
    let transaction = &mut input["intent"]["transaction"];
    transaction["categoryId"] = Value::Null;
    transaction["splits"] = json!([
        {"categoryId": "food", "amount": money(-200, "USD")},
        {"categoryId": "food", "amount": money(-300, "USD")}
    ]);
    let splits = transaction["splits"].clone();
    let effect =
        &mut input["decisionCardRequest"]["financialSnapshot"]["observations"][1]["ledgerEffect"];
    effect["categoryId"] = Value::Null;
    effect["splits"] = splits;
    let planned = plan(input.clone());
    assert_eq!(
        verify(verify_request(planned, input.clone(), "preconditions"))["valid"],
        true
    );
    for (change, reason) in [
        ("sum", "invalid_economic_event_ledger_effect"),
        ("category", "invalid_economic_event_ledger_effect"),
        ("currency", "invalid_economic_event_ledger_effect"),
        ("overflow", "money_arithmetic_overflow"),
    ] {
        let mut changed = input.clone();
        let splits = &mut changed["decisionCardRequest"]["financialSnapshot"]["observations"][1]
            ["ledgerEffect"]["splits"];
        match change {
            "sum" => splits[1]["amount"] = money(-301, "USD"),
            "category" => splits[0]["categoryId"] = json!(" "),
            "currency" => splits[0]["amount"] = money(-200, "EUR"),
            "overflow" => {
                splits[0]["amount"] = money(i64::MIN, "USD");
                splits[1]["amount"] = money(-1, "USD");
            }
            _ => unreachable!(),
        }
        assert_eq!(plan_request(changed).unwrap_err(), reason, "{change}");
    }
}

#[test]
fn manual_payee_resolution_requires_complete_unambiguous_coverage() {
    let input = immediate_manual_request("single");
    for coverage in ["unknown", "partial", "unavailable"] {
        let mut changed = input.clone();
        changed["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!(coverage);
        assert_eq!(
            plan_request(changed).unwrap_err(),
            "manual_payee_coverage_incomplete",
            "{coverage}"
        );
    }
    let mut ambiguous = input.clone();
    ambiguous["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!("complete");
    ambiguous["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"] = json!([
        {"id": "shop-1", "name": "Local shop", "transferAccountId": null, "mtid": null},
        {"id": "shop-2", "name": " Local shop ", "transferAccountId": null, "mtid": null}
    ]);
    assert_eq!(
        plan_request(ambiguous.clone()).unwrap_err(),
        "manual_payee_ambiguous"
    );
    ambiguous["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] = json!("empty");
    assert_eq!(
        plan_request(ambiguous).unwrap_err(),
        "manual_payee_coverage_incomplete"
    );
    let mut unnamed = input;
    unnamed["intent"]["transaction"]["payeeName"] = Value::Null;
    let planned = plan(unnamed.clone());
    assert_eq!(planned["source"]["manualPayeeBindings"], json!([]));
    let transaction = unnamed["intent"]["transaction"].clone();
    apply_manual_postconditions(&mut unnamed, &transaction, 11_000, 0);
    assert_eq!(
        verify(verify_request(planned, unnamed, "postconditions"))["valid"],
        true
    );
}

#[test]
fn action_clock_and_resolved_evidence_reject_invalid_external_identities() {
    for evaluated_at in [
        "2026-09-06T10:00:00+00:00",
        "2026-09-06T10:00:00.Z",
        "2026-09-06T10:00:00.1234567890Z",
        "2026-09-06T24:00:00Z",
        "2026-09-06T10:60:00Z",
        "2026-09-06T10:00:60Z",
        "2026-09-06T1a:00:00Z",
        "2026-02-29T10:00:00Z",
    ] {
        let mut input = request();
        input["evaluatedAt"] = json!(evaluated_at);
        assert_eq!(
            plan_request(input).unwrap_err(),
            "invalid_evaluated_at",
            "{evaluated_at}"
        );
    }
    for (field, value, reason) in [
        ("evidenceId", " ", "invalid_or_duplicate_evidence"),
        ("subjectId", "", "invalid_or_duplicate_evidence"),
        ("contentHash", " ", "invalid_evidence_identity"),
        ("version", " ", "invalid_evidence_identity"),
    ] {
        let mut input = request();
        input["resolvedEvidence"][0][field] = json!(value);
        assert_eq!(plan_request(input).unwrap_err(), reason, "{field}");
    }
}

#[test]
fn supplemental_authority_rejects_duplicate_and_aliased_obligations() {
    let mut input = immediate_manual_request("single");
    add_user_attested_flow_and_obligation(&mut input, "checking");
    assert!(plan_request(input.clone()).is_ok());
    for (change, reason) in [
        ("account", "invalid_or_duplicate_supplemental_account"),
        ("field", "duplicate_supplemental_field"),
        ("source", "supplemental_field_source_mismatch"),
        (
            "obligation_alias",
            "invalid_supplemental_obligation_binding",
        ),
        (
            "obligation_baseline",
            "invalid_supplemental_obligation_binding",
        ),
        ("flow_alias", "invalid_supplemental_flow_binding"),
    ] {
        let mut changed = input.clone();
        match change {
            "account" => {
                let duplicate = changed["supplementalObservations"][0].clone();
                changed["supplementalObservations"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "field" => {
                changed["supplementalObservations"][0]["fields"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("currency"));
            }
            "source" => {
                account_fact_mut(&mut changed, "checking")["currencyEvidence"]["source"] =
                    json!("actual_ledger")
            }
            "obligation_alias" => {
                let account = account_fact_mut(&mut changed, "checking");
                let mut alias = account["obligations"][0].clone();
                alias["id"] = json!("second-name-for-same-obligation");
                account["obligations"].as_array_mut().unwrap().push(alias);
            }
            "obligation_baseline" => {
                let account = account_fact_mut(&mut changed, "checking");
                account["baselineTransactionIds"] = json!(["already-counted"]);
                account["obligations"][0]["matchedTransactionIds"] = json!(["already-counted"]);
            }
            "flow_alias" => {
                let account = account_fact_mut(&mut changed, "checking");
                let mut alias = account["unsettledFlows"][0].clone();
                alias["id"] = json!("second-name-for-same-flow");
                account["unsettledFlows"]
                    .as_array_mut()
                    .unwrap()
                    .push(alias);
            }
            _ => unreachable!(),
        }
        assert_eq!(plan_request(changed).unwrap_err(), reason, "{change}");
    }
}

#[test]
fn recovery_rejects_ambiguous_created_payees_and_duplicate_actual_projections() {
    let (planned, input) = shared_new_payee_readback("complete");
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            input.clone(),
            "postconditions"
        ))["valid"],
        true
    );
    for change in [
        "payee_duplicate",
        "payee_name",
        "payee_transfer",
        "payee_import",
        "observation_duplicate",
        "baseline_duplicate",
        "flow_duplicate",
        "flow_matching",
        "cleared",
    ] {
        let mut changed = input.clone();
        let snapshot = &mut changed["decisionCardRequest"]["financialSnapshot"];
        match change {
            "payee_duplicate" => {
                let duplicate = snapshot["legacySnapshot"]["payees"][0].clone();
                snapshot["legacySnapshot"]["payees"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "payee_name" => snapshot["legacySnapshot"]["payees"][0]["name"] = json!("Other shop"),
            "payee_transfer" => {
                snapshot["legacySnapshot"]["payees"][0]["transferAccountId"] = json!("savings")
            }
            "payee_import" => {
                snapshot["legacySnapshot"]["payees"][0]["mtid"] = json!("externally-imported")
            }
            "observation_duplicate" => {
                let duplicate = snapshot["observations"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|observation| observation["kind"] == "pending_activity")
                    .unwrap()
                    .clone();
                snapshot["observations"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "baseline_duplicate" => {
                let account = account_fact_mut(&mut changed, "checking");
                account["baselineTransactionIds"]
                    .as_array_mut()
                    .unwrap()
                    .push(json!("manual-parent-2"));
            }
            "flow_duplicate" => {
                let account = account_fact_mut(&mut changed, "checking");
                let duplicate = account["unsettledFlows"]
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|flow| flow["id"] == "manual-parent-2")
                    .unwrap()
                    .clone();
                account["unsettledFlows"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "flow_matching" => {
                let account = account_fact_mut(&mut changed, "checking");
                let flow = account["unsettledFlows"]
                    .as_array_mut()
                    .unwrap()
                    .iter_mut()
                    .find(|flow| flow["id"] == "manual-parent-2")
                    .unwrap();
                flow["matchedTransactionIds"] = json!(["unrelated-bank-row"]);
            }
            "cleared" => snapshot["legacySnapshot"]["transactions"][0]["cleared"] = json!(true),
            _ => unreachable!(),
        }
        assert_eq!(
            verify(verify_request(planned.clone(), changed, "postconditions"))["valid"],
            false,
            "{change}"
        );
    }
}

#[test]
fn transfer_invalidates_attested_card_credit_without_reusing_its_authority() {
    let mut input = request();
    input["intent"] = json!({"kind": "transfer", "transferId": "credit-payment", "correlationId": "credit-payment-correlation",
        "sourceAccountId": "checking", "destinationAccountId": "savings", "amount": money(1_000, "USD"), "date": "2026-09-06"});
    ledger_account_mut(&mut input, "savings")["balance"] = money(-5_000, "USD");
    let savings = account_fact_mut(&mut input, "savings");
    savings["recordedBalance"] = money(-5_000, "USD");
    savings["kind"] = json!("credit");
    savings["credit"] = json!({
        "authorizationAvailable": money(5_000, "USD"), "pendingIncludedInAuthorization": true,
        "paymentAccountId": "checking", "paymentCategoryId": "reserve", "dueAt": "2026-09-20T09:00:00Z",
        "reservedCash": money(0, "USD"), "economicObligationId": "card-payment-obligation",
        "evidence": savings["kindEvidence"].clone()
    });
    category_fact_mut(&mut input, "reserve")["kind"] = json!("credit_payment");
    for account_id in ["checking", "savings"] {
        add_legacy_account_from_current_ledger(&mut input, account_id);
    }
    add_supplemental_observations(&mut input, &["savings"]);
    input["supplementalObservations"][0]["fields"]
        .as_array_mut()
        .unwrap()
        .push(json!("credit"));
    recapture_actual_source(&mut input, EVALUATED_AT);
    set_actual_base_balance_evidence(&mut input, "savings", EVALUATED_AT);
    let planned = plan(input.clone());
    assert!(
        planned["source"]["invalidatedSupplementalFacts"][0]["paths"]
            .as_array()
            .unwrap()
            .contains(&json!("credit"))
    );
    let mut false_provenance = input.clone();
    account_fact_mut(&mut false_provenance, "savings")["credit"]["evidence"]["source"] =
        json!("actual_ledger");
    assert_eq!(
        plan_request(false_provenance).unwrap_err(),
        "supplemental_field_source_mismatch"
    );
    apply_transfer_postconditions(
        &mut input,
        "credit-payment",
        "credit-payment-correlation",
        true,
    );
    ledger_account_mut(&mut input, "savings")["balance"] = money(-4_000, "USD");
    recapture_actual_source(&mut input, "2026-09-06T10:01:00Z");
    apply_actual_account_projection(&mut input, "savings", "2026-09-06T10:01:00Z");
    let recovered = verify(verify_request(
        planned.clone(),
        input.clone(),
        "postconditions",
    ));
    assert_eq!(recovered["valid"], true, "{recovered}");
    let mut retained_credit = input.clone();
    account_fact_mut(&mut retained_credit, "savings")["credit"] = json!({
        "authorizationAvailable": money(5_000, "USD"), "pendingIncludedInAuthorization": true,
        "paymentAccountId": "checking", "paymentCategoryId": "reserve", "dueAt": "2026-09-20T09:00:00Z",
        "reservedCash": money(0, "USD"), "economicObligationId": "card-payment-obligation",
        "evidence": actual_fact_evidence("unknown", "2026-09-06T10:01:00Z", &[])
    });
    assert_eq!(
        verify(verify_request(planned, retained_credit, "postconditions"))["valid"],
        false
    );
}

#[test]
fn legacy_manual_readback_preserves_existing_payees_and_allows_no_payee() {
    for named in [false, true] {
        let mut input = immediate_manual_request("single");
        if named {
            input["decisionCardRequest"]["financialSnapshot"]["coverage"]["payees"] =
                json!("complete");
            input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"] = json!([
                {"id": "existing-shop", "name": "Local shop", "transferAccountId": null, "mtid": null}
            ]);
        } else {
            input["intent"]["transaction"]["payeeName"] = Value::Null;
        }
        add_legacy_account_from_current_ledger(&mut input, "checking");
        recapture_actual_source(&mut input, EVALUATED_AT);
        let planned = plan(input.clone());
        let transaction = input["intent"]["transaction"].clone();
        apply_manual_postconditions(&mut input, &transaction, 11_000, 0);
        set_legacy_account_balance(&mut input, "checking", money(11_000, "USD"));
        input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"] = json!([{
            "id": transaction["parentId"], "accountId": "checking", "date": "2026-09-06",
            "payeeId": if named { json!("existing-shop") } else { Value::Null }, "payeeName": transaction["payeeName"],
            "categoryId": "food", "categoryName": null, "amount": money(-2_000, "USD"), "cleared": false,
            "reconciled": false, "importedId": null, "importedPayee": null, "notes": null, "tags": [],
            "transferAccountId": null, "subtransactions": []
        }]);
        assert_eq!(
            verify(verify_request(
                planned.clone(),
                input.clone(),
                "postconditions"
            ))["valid"],
            true,
            "named={named}"
        );
        let mut wrong_payee = input.clone();
        wrong_payee["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"]
            [0]["payeeId"] = json!("different-shop");
        assert_eq!(
            verify(verify_request(
                planned.clone(),
                wrong_payee,
                "postconditions"
            ))["valid"],
            false,
            "named={named}"
        );
        if named {
            let mut wrong_binding = input.clone();
            wrong_binding["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]
                ["transactions"][0]["payeeId"] = json!("second-shop");
            wrong_binding["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"].as_array_mut().unwrap().push(json!({
                "id": "second-shop", "name": "Local shop", "transferAccountId": null, "mtid": null
            }));
            assert_eq!(
                verify(verify_request(planned, wrong_binding, "postconditions"))["valid"],
                false
            );
        }
    }
}

#[test]
fn ledger_contract_rejects_orphaned_and_duplicate_financial_rows() {
    for (change, reason) in [
        ("account", "invalid_or_duplicate_ledger_account"),
        ("category", "invalid_or_duplicate_ledger_category"),
        ("assignment", "invalid_or_duplicate_assignment"),
        ("wallet", "invalid_or_duplicate_wallet_mapping"),
        ("transaction_account", "transaction_account_missing"),
        (
            "transaction_date",
            "invalid_or_duplicate_ledger_transaction",
        ),
        (
            "transaction_split",
            "invalid_or_duplicate_ledger_transaction",
        ),
        (
            "transaction_transfer",
            "transaction_transfer_account_missing",
        ),
    ] {
        let mut input = request();
        match change {
            "account" => {
                let duplicate = input["currentLedger"]["accounts"][0].clone();
                input["currentLedger"]["accounts"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "category" => {
                let duplicate = input["currentLedger"]["categories"][0].clone();
                input["currentLedger"]["categories"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "assignment" => {
                input["currentLedger"]["assignments"][0]["asOfMonth"] = json!("2026-13")
            }
            "wallet" => {
                input["currentLedger"]["wallets"] =
                    json!([{"walletId": "orphan-wallet", "accountId": "missing-account"}])
            }
            _ => {
                let mut transaction =
                    actual_manual_row(&manual_transaction(money(-100, "USD"), vec![]));
                match change {
                    "transaction_account" => transaction["accountId"] = json!("missing-account"),
                    "transaction_date" => transaction["date"] = json!("2026-09-31"),
                    "transaction_split" => {
                        transaction["splits"] = json!([{"categoryId": "missing-category", "amount": money(-100, "USD")}])
                    }
                    "transaction_transfer" => {
                        transaction["transferAccountId"] = json!("missing-account")
                    }
                    _ => unreachable!(),
                }
                input["currentLedger"]["transactions"] = json!([transaction]);
            }
        }
        assert_eq!(plan_request(input).unwrap_err(), reason, "{change}");
    }
}

#[test]
fn existing_transfer_mappings_require_distinct_exact_linked_ledger_rows() {
    let mut input = request();
    apply_transfer_postconditions(
        &mut input,
        "existing-transfer",
        "existing-correlation",
        true,
    );
    input["intent"] = json!({"kind": "wallet_materialization", "walletId": "wallet-new-1",
        "accountName": "Emergency savings", "currency": "USD"});
    assert!(plan_request(input.clone()).is_ok());
    for (change, reason) in [
        ("duplicate", "invalid_or_duplicate_transfer_mapping"),
        ("identity", "invalid_or_duplicate_transfer_mapping"),
        ("source", "transfer_source_row_missing"),
        ("destination", "transfer_destination_row_missing"),
        ("same_row", "invalid_or_duplicate_transfer_mapping"),
        ("counterparty", "transfer_mapping_mismatch"),
        ("marker", "transfer_mapping_mismatch"),
        ("amount", "transfer_mapping_mismatch"),
        ("category", "transfer_mapping_mismatch"),
    ] {
        let mut changed = input.clone();
        match change {
            "duplicate" => {
                let duplicate = changed["currentLedger"]["transfers"][0].clone();
                changed["currentLedger"]["transfers"]
                    .as_array_mut()
                    .unwrap()
                    .push(duplicate);
            }
            "identity" => changed["currentLedger"]["transfers"][0]["correlationId"] = json!(" "),
            "source" => {
                changed["currentLedger"]["transfers"][0]["sourceTransactionId"] =
                    json!("missing-source")
            }
            "destination" => {
                changed["currentLedger"]["transfers"][0]["destinationTransactionId"] =
                    json!("missing-destination")
            }
            "same_row" => {
                changed["currentLedger"]["transfers"][0]["destinationTransactionId"] =
                    changed["currentLedger"]["transfers"][0]["sourceTransactionId"].clone()
            }
            "counterparty" => {
                changed["currentLedger"]["transactions"][0]["transferAccountId"] = Value::Null
            }
            "marker" => {
                changed["currentLedger"]["transactions"][0]["notes"] = json!("other-marker")
            }
            "amount" => changed["currentLedger"]["transfers"][0]["amount"] = money(0, "USD"),
            "category" => changed["currentLedger"]["transactions"][0]["categoryId"] = json!("food"),
            _ => unreachable!(),
        }
        assert_eq!(plan_request(changed).unwrap_err(), reason, "{change}");
    }
}

#[test]
fn source_contract_requires_identity_coverage_and_nonfuture_resolution_observations() {
    for (change, reason) in [
        ("identity", "missing_action_identity"),
        ("snapshot", "source_identity_mismatch"),
        ("coverage", "source_coverage_incomplete"),
        ("items", "purchase_card_required_for_category_action"),
        ("composite", "composite_action_empty"),
        ("future", "invalid_or_future_observation_time"),
        ("scope", "invalid_economic_event_resolution_scope"),
        ("resolved_metadata", "resolution_metadata_not_allowed"),
    ] {
        let mut input = request();
        match change {
            "identity" => input["idempotencyKey"] = json!(" "),
            "snapshot" => {
                input["decisionCardRequest"]["context"]["snapshotId"] = json!("different-source")
            }
            "coverage" => {
                input["decisionCardRequest"]["financialSnapshot"]["coverage"]["accounts"] =
                    json!("unknown")
            }
            "items" => input["decisionCardRequest"]["items"] = json!([]),
            "composite" => input["intent"] = json!({"kind": "composite", "actions": []}),
            "future" => {
                input["decisionCardRequest"]["financialSnapshot"]["observations"][0]["observedAt"] =
                    json!("2026-09-06T10:00:00.000000001Z")
            }
            "scope" => {
                input["decisionCardRequest"]["financialSnapshot"]["observations"][1]["scope"] =
                    json!({"kind": "global"})
            }
            "resolved_metadata" => {
                input["decisionCardRequest"]["financialSnapshot"]["observations"][0]["state"] =
                    json!("resolved")
            }
            _ => unreachable!(),
        }
        assert_eq!(plan_request(input).unwrap_err(), reason, "{change}");
    }
}

#[test]
fn actual_transfer_readback_removes_only_its_pair_and_unverified_credit_projection() {
    let mut input = request();
    input["intent"] = json!({"kind": "transfer", "transferId": "ledger-transfer-1", "correlationId": "transfer-correlation-1",
        "sourceAccountId": "checking", "destinationAccountId": "savings", "amount": money(1_000, "USD"), "date": "2026-09-06"});
    for account_id in ["checking", "savings"] {
        add_legacy_account_from_current_ledger(&mut input, account_id);
        set_actual_base_balance_evidence(&mut input, account_id, EVALUATED_AT);
    }
    add_supplemental_observations(&mut input, &["checking", "savings"]);
    recapture_actual_source(&mut input, EVALUATED_AT);
    let planned = plan(input.clone());
    apply_transfer_postconditions(
        &mut input,
        "ledger-transfer-1",
        "transfer-correlation-1",
        true,
    );
    let legacy_rows: Vec<_> = input["currentLedger"]["transactions"].as_array().unwrap().iter().map(|transaction| {
        json!({"id": transaction["parentId"], "accountId": transaction["accountId"], "date": transaction["date"],
            "payeeId": null, "payeeName": null, "categoryId": null, "categoryName": null, "amount": transaction["amount"],
            "cleared": false, "reconciled": false, "importedId": null, "importedPayee": null,
            "notes": transaction["notes"], "tags": [], "transferAccountId": transaction["transferAccountId"], "subtransactions": []})
    }).collect();
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"] =
        json!(legacy_rows);
    set_legacy_account_balance(&mut input, "checking", money(12_000, "USD"));
    set_legacy_account_balance(&mut input, "savings", money(21_000, "USD"));
    recapture_actual_source(&mut input, "2026-09-06T10:01:00Z");
    for account_id in ["checking", "savings"] {
        apply_actual_account_projection(&mut input, account_id, "2026-09-06T10:01:00Z");
    }
    assert_eq!(
        account_fact_mut(&mut input, "savings")["activityEvidence"]["reasons"],
        json!(["manual_transfer_credit_unverified"])
    );
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            input.clone(),
            "postconditions"
        ))["valid"],
        true
    );
    for change in [
        "partial_pair",
        "imported",
        "counterparty",
        "notes",
        "duplicate_pair",
    ] {
        let mut changed = input.clone();
        let rows = &mut changed["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]
            ["transactions"];
        match change {
            "partial_pair" => {
                rows.as_array_mut().unwrap().pop();
            }
            "imported" => rows[0]["importedId"] = json!("new-bank-import"),
            "counterparty" => rows[0]["transferAccountId"] = json!("checking"),
            "notes" => rows[0]["notes"] = json!("unrelated-row"),
            "duplicate_pair" => {
                let duplicate = rows[0].clone();
                rows.as_array_mut().unwrap().push(duplicate);
            }
            _ => unreachable!(),
        }
        let result = verify(verify_request(planned.clone(), changed, "postconditions"));
        assert_eq!(result["valid"], false, "{change}");
        assert_eq!(result["reason"], "postcondition_mismatch", "{change}");
    }
}

#[test]
fn composite_manual_and_transfer_can_reach_the_exact_protected_buffer() {
    for transfer_first in [false, true] {
        let mut input = immediate_manual_request("single");
        let manual = input["intent"].clone();
        let transfer = json!({"kind": "transfer", "transferId": "buffer-boundary", "correlationId": "buffer-boundary-correlation",
            "sourceAccountId": "checking", "destinationAccountId": "savings", "amount": money(1_000, "USD"), "date": "2026-09-06"});
        input["intent"] = json!({"kind": "composite", "actions": if transfer_first { vec![transfer, manual] } else { vec![manual, transfer] }});
        let planned = plan(input.clone());
        assert!(planned["expectedPostconditions"]
            .as_array()
            .unwrap()
            .iter()
            .any(|condition| condition["kind"] == "account_balance"
                && condition["accountId"] == "checking"
                && condition["balance"] == money(10_000, "USD")));
        assert_eq!(
            verify(verify_request(planned, input, "preconditions"))["valid"],
            true,
            "transfer_first={transfer_first}"
        );
    }
}

fn evidence_credit_request() -> Value {
    let mut input = evidence_projection_request();
    input["intent"]["kind"] = json!("evidence_credit");
    input["intent"]["transaction"]["amount"] = money(500, "USD");
    input["decisionCardRequest"]["items"] = json!([]);
    let observations = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap();
    let resolution = observations
        .iter_mut()
        .find(|o| o["kind"] == "economic_event_resolution")
        .unwrap();
    resolution["ledgerEffect"]["amount"] = money(500, "USD");
    input
}
fn evidence_amendment_request() -> Value {
    let mut input = evidence_projection_request();
    let tx = input["intent"]["transaction"].clone();
    let mut expected = actual_manual_row(&tx);
    expected["categoryId"] = Value::Null;
    let source = json!({"id":tx["parentId"],"accountId":tx["accountId"],"date":tx["date"],"payeeId":null,"payeeName":tx["payeeName"],"categoryId":null,"categoryName":null,"amount":tx["amount"],"cleared":true,"reconciled":false,"importedId":"settlement-original","importedPayee":null,"notes":tx["notes"],"tags":[],"transferAccountId":null,"subtransactions":[]});
    input["currentLedger"]["transactions"] = json!([expected.clone()]);
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"] =
        json!([source.clone()]);
    input["decisionCardRequest"]["items"] = json!([]);
    input["intent"] = json!({"kind":"evidence_amendment","expected":expected,"expectedSource":source,"transaction":tx,"evidenceIds":input["intent"]["evidenceIds"]});
    input
}
#[test]
fn governed_evidence_credit_is_positive_source_bound_and_manual_remains_debit_only() {
    let input = evidence_credit_request();
    let proposed = plan(input.clone());
    assert_eq!(proposed["action"]["kind"], "evidence_credit");
    assert!(hash_is_sha256(&proposed["actionHash"]));
    assert_eq!(
        verify(verify_request(
            proposed.clone(),
            input.clone(),
            "preconditions"
        ))["valid"],
        true
    );
    let mut after = input.clone();
    let tx = after["intent"]["transaction"].clone();
    apply_manual_postconditions(&mut after, &tx, 13500, 2500);
    assert_eq!(
        verify(verify_request(
            proposed.clone(),
            after.clone(),
            "postconditions"
        ))["valid"],
        true
    );
    after["currentLedger"]["transactions"][0]["amount"] = money(499, "USD");
    assert_eq!(
        verify(verify_request(proposed, after, "postconditions"))["valid"],
        false
    );
    for amount in [0, -500] {
        let mut invalid = input.clone();
        invalid["intent"]["transaction"]["amount"] = money(amount, "USD");
        assert!(plan_request(invalid).is_err());
    }
    let mut manual = input;
    manual["intent"] =
        json!({"kind":"manual_transaction","transaction":manual["intent"]["transaction"]});
    assert!(plan_request(manual).is_err());
}
#[test]
fn governed_amendment_changes_only_category_or_splits_and_pins_full_original_source() {
    let input = evidence_amendment_request();
    let proposed = plan(input.clone());
    assert_eq!(proposed["action"]["kind"], "evidence_amendment");
    assert_eq!(
        verify(verify_request(
            proposed.clone(),
            input.clone(),
            "preconditions"
        ))["valid"],
        true
    );
    let mut after = input.clone();
    let tx = after["intent"]["transaction"].clone();
    after["currentLedger"]["transactions"][0] = actual_manual_row(&tx);
    after["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
        ["categoryId"] = tx["categoryId"].clone();
    category_fact_mut(&mut after, "food")["availability"] = money(1500, "USD");
    assert_eq!(
        verify(verify_request(
            proposed.clone(),
            after.clone(),
            "postconditions"
        ))["valid"],
        true
    );
    after["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
        ["importedId"] = json!("changed-import");
    assert_eq!(
        verify(verify_request(proposed.clone(), after, "postconditions"))["valid"],
        false
    );
    for (pointer, value) in [
        ("/intent/transaction/amount", money(-499, "USD")),
        ("/intent/transaction/accountId", json!("savings")),
        ("/intent/transaction/date", json!("2026-09-07")),
        ("/intent/transaction/payeeName", json!("Changed")),
        ("/intent/expectedSource/reconciled", json!(true)),
    ] {
        let mut invalid = input.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(plan_request(invalid).is_err(), "{pointer}");
    }
    let mut stale = input;
    stale["currentLedger"]["transactions"][0]["notes"] = json!("external change");
    assert_eq!(
        verify(verify_request(proposed, stale, "preconditions"))["valid"],
        false
    );
}
#[test]
fn exact_amendment_readback_with_a_new_capture_uses_verified_observation_time_after_expiry() {
    let mut input = evidence_amendment_request();
    recapture_actual_source(&mut input, EVALUATED_AT);
    let original = plan(input.clone());
    let transaction = input["intent"]["transaction"].clone();
    let mut after = input.clone();
    after["currentLedger"]["transactions"][0] = actual_manual_row(&transaction);
    after["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
        ["categoryId"] = transaction["categoryId"].clone();
    category_fact_mut(&mut after, "food")["availability"] = money(1500, "USD");
    for captured_at in ["2026-09-06T10:02:00Z", "2026-09-07T18:00:00Z"] {
        let mut captured = after.clone();
        recapture_actual_source(&mut captured, captured_at);
        captured["evaluatedAt"] = json!(captured_at);
        captured["decisionCardRequest"]["context"]["evaluatedAt"] = json!(EVALUATED_AT);
        assert_eq!(
            verify(verify_request(
                original.clone(),
                captured.clone(),
                "postconditions"
            ))["valid"],
            true,
            "exact read-only recovery at {captured_at}"
        );
        let mut future = captured.clone();
        future["evaluatedAt"] = json!(EVALUATED_AT);
        assert_eq!(
            verify(verify_request(original.clone(), future, "postconditions"))["valid"],
            false,
            "future captures cannot be rebased into authority"
        );
        if captured_at.starts_with("2026-09-07") {
            assert_eq!(
                verify(verify_request(
                    original.clone(),
                    captured.clone(),
                    "preconditions"
                ))["valid"],
                false,
                "expired recovery cannot authorize dispatch"
            );
            assert!(
                plan_request(captured.clone()).is_err(),
                "expired rereads cannot create a new approval"
            );
        }
        captured["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
            ["notes"] = json!("unauthorized edit");
        assert_eq!(
            verify(verify_request(original.clone(), captured, "postconditions"))["valid"],
            false
        );
    }
}

#[test]
fn amendment_splits_verify_new_child_metadata_and_exact_category_effects() {
    let mut input = evidence_amendment_request();
    let splits = json!([{"categoryId":"food","amount":money(-200,"USD")},{"categoryId":"reserve","amount":money(-300,"USD")}]);
    input["intent"]["transaction"]["categoryId"] = Value::Null;
    input["intent"]["transaction"]["splits"] = splits.clone();
    let resolution = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["kind"] == "economic_event_resolution")
        .unwrap();
    resolution["ledgerEffect"]["categoryId"] = Value::Null;
    resolution["ledgerEffect"]["splits"] = splits;
    let proposed = plan(input.clone());
    let mut after = input.clone();
    after["currentLedger"]["transactions"][0] = actual_manual_row(&input["intent"]["transaction"]);
    let mut children = vec![];
    for (index, split) in input["intent"]["transaction"]["splits"]
        .as_array()
        .unwrap()
        .iter()
        .enumerate()
    {
        let mut child = input["intent"]["expectedSource"].clone();
        child["id"] = json!(format!("amended-child-{index}"));
        child["payeeName"] = Value::Null;
        child["importedId"] = Value::Null;
        child["categoryId"] = split["categoryId"].clone();
        child["amount"] = split["amount"].clone();
        children.push(child);
    }
    after["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
        ["subtransactions"] = json!(children);
    category_fact_mut(&mut after, "food")["availability"] = money(1800, "USD");
    category_fact_mut(&mut after, "reserve")["availability"] = money(5700, "USD");
    assert_eq!(
        verify(verify_request(
            proposed.clone(),
            after.clone(),
            "postconditions"
        ))["valid"],
        true
    );
    after["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
        ["subtransactions"][0]["notes"] = json!("unapproved metadata");
    assert_eq!(
        verify(verify_request(proposed, after, "postconditions"))["valid"],
        false
    );
}
#[test]
fn evidence_credit_and_amendment_refuse_stale_missing_conflicting_or_overflowing_facts() {
    for pointer in [
        "/decisionCardRequest/financialSnapshot/capturedAt",
        "/decisionCardRequest/liquidityPolicy/expiresAt",
    ] {
        let mut stale = evidence_credit_request();
        *stale.pointer_mut(pointer).unwrap() = json!("2026-01-01T00:00:00Z");
        assert!(plan_request(stale).is_err());
    }
    let mut overflow = evidence_credit_request();
    ledger_account_mut(&mut overflow, "checking")["balance"] = money(i64::MAX, "USD");
    account_fact_mut(&mut overflow, "checking")["recordedBalance"] = money(i64::MAX, "USD");
    assert!(plan_request(overflow).unwrap_err().contains("overflow"));
    let mut missing = evidence_credit_request();
    missing["intent"]["evidenceIds"] = json!([]);
    assert!(plan_request(missing).is_err());
    for (pointer, value) in [
        ("/intent/transaction/categoryId", json!("missing")),
        ("/intent/transaction/amount", money(500, "EUR")),
        ("/intent/transaction/date", json!("2026-09-07")),
        (
            "/decisionCardRequest/context/policy/maxBudgetSnapshotAgeMinutes",
            Value::Null,
        ),
    ] {
        let mut invalid = evidence_credit_request();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(plan_request(invalid).is_err(), "{pointer}");
    }
    let input = evidence_amendment_request();
    for (pointer, value) in [
        ("/intent/expectedSource/importedId", json!("changed")),
        ("/intent/expected/transferAccountId", json!("savings")),
        ("/intent/transaction/parentId", json!("different-parent")),
    ] {
        let mut invalid = input.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(plan_request(invalid).is_err(), "{pointer}");
    }
    let mut wrong_target = input.clone();
    wrong_target["resolvedEvidence"][1]["subjectId"] = json!("other-event");
    assert!(plan_request(wrong_target).is_err());
    let mut missing = input;
    missing["currentLedger"]["transactions"] = json!([]);
    assert!(plan_request(missing).is_err());
}
#[test]
fn existing_split_amendment_preserves_child_ids_and_metadata_and_refuses_reshape() {
    let mut input = evidence_amendment_request();
    let before_splits = json!([{"categoryId":"reserve","amount":money(-500,"USD")}]);
    input["intent"]["expected"]["splits"] = before_splits;
    let mut child = input["intent"]["expectedSource"].clone();
    child["id"] = json!("existing-child");
    child["categoryId"] = json!("reserve");
    child["notes"] = json!("retain child note");
    input["intent"]["expectedSource"]["subtransactions"] = json!([child]);
    input["currentLedger"]["transactions"][0] = input["intent"]["expected"].clone();
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0] =
        input["intent"]["expectedSource"].clone();
    let after_splits = json!([{"categoryId":"food","amount":money(-500,"USD")}]);
    input["intent"]["transaction"]["categoryId"] = Value::Null;
    input["intent"]["transaction"]["splits"] = after_splits.clone();
    let resolution = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["kind"] == "economic_event_resolution")
        .unwrap();
    resolution["ledgerEffect"]["categoryId"] = Value::Null;
    resolution["ledgerEffect"]["splits"] = after_splits;
    let proposed = plan(input.clone());
    let mut after = input.clone();
    after["currentLedger"]["transactions"][0] = actual_manual_row(&input["intent"]["transaction"]);
    after["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
        ["subtransactions"][0]["categoryId"] = json!("food");
    category_fact_mut(&mut after, "reserve")["availability"] = money(6500, "USD");
    category_fact_mut(&mut after, "food")["availability"] = money(1500, "USD");
    assert_eq!(
        verify(verify_request(
            proposed.clone(),
            after.clone(),
            "postconditions"
        ))["valid"],
        true
    );
    after["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
        ["subtransactions"][0]["id"] = json!("replaced-child");
    assert_eq!(
        verify(verify_request(proposed, after, "postconditions"))["valid"],
        false
    );
    input["intent"]["transaction"]["splits"] = json!([]);
    input["intent"]["transaction"]["categoryId"] = json!("food");
    assert!(plan_request(input).unwrap_err().contains("reshape"));
}
#[test]
fn governed_credit_splits_conserve_the_inflow_and_reject_mixed_sign_or_category_parent() {
    let mut input = evidence_credit_request();
    input["intent"]["transaction"]["categoryId"] = Value::Null;
    input["intent"]["transaction"]["splits"] =
        json!([{"categoryId":"food","amount":money(500,"USD")}]);
    let resolution = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .find(|o| o["kind"] == "economic_event_resolution")
        .unwrap();
    resolution["ledgerEffect"]["categoryId"] = Value::Null;
    resolution["ledgerEffect"]["splits"] = json!([{"categoryId":"food","amount":money(500,"USD")}]);
    assert!(plan_request(input.clone()).is_ok());
    for (pointer, value) in [
        ("/intent/transaction/splits/0/amount", money(-500, "USD")),
        ("/intent/transaction/splits/0/amount", money(499, "USD")),
        ("/intent/transaction/categoryId", json!("food")),
    ] {
        let mut invalid = input.clone();
        *invalid.pointer_mut(pointer).unwrap() = value;
        assert!(plan_request(invalid).is_err());
    }
    let mut duplicate = evidence_credit_request();
    duplicate["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"] =
        json!([evidence_amendment_request()["intent"]["expectedSource"]]);
    assert!(plan_request(duplicate)
        .unwrap_err()
        .contains("duplicate_evidence_credit_source"));
}
#[test]
fn amendment_requires_original_category_facts_before_dispatch() {
    let mut input = evidence_amendment_request();
    input["intent"]["expected"]["categoryId"] = json!("reserve");
    input["intent"]["expectedSource"]["categoryId"] = json!("reserve");
    input["currentLedger"]["transactions"][0] = input["intent"]["expected"].clone();
    input["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0] =
        input["intent"]["expectedSource"].clone();
    input["decisionCardRequest"]["financialSnapshot"]["liquidity"]["categories"]
        .as_array_mut()
        .unwrap()
        .retain(|category| category["categoryId"] != "reserve");
    assert!(plan_request(input).is_err());
}

fn shared_statement_credit_request() -> Value {
    let mut input = evidence_credit_request();
    let original = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["kind"] == "economic_event_resolution")
        .unwrap()
        .clone();
    let mut second = original;
    second["scope"]["id"] = json!("statement-event-two");
    second["contentHash"] = json!("statement-event-two-hash");
    input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(second);
    let mut proof = input["resolvedEvidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["evidenceId"] == input["intent"]["evidenceIds"][0])
        .unwrap()
        .clone();
    proof["subjectId"] = json!("statement-event-two");
    proof["contentHash"] = json!("statement-event-two-hash");
    input["resolvedEvidence"]
        .as_array_mut()
        .unwrap()
        .push(proof);
    input
}

#[test]
fn shared_statement_requires_exact_subject_and_allows_distinct_event_composite() {
    let input = shared_statement_credit_request();
    assert!(
        plan_request(input.clone()).is_err(),
        "legacy ambiguous document cannot choose first proof"
    );
    let original_subject = input["resolvedEvidence"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["evidenceId"] == input["intent"]["evidenceIds"][0])
        .unwrap()["subjectId"]
        .clone();
    let mut first = input.clone();
    first["intent"]["resolutionSubjectId"] = original_subject;
    assert_eq!(
        plan(first.clone())["evidenceReferences"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
    let mut second = input.clone();
    second["intent"]["resolutionSubjectId"] = json!("statement-event-two");
    second["intent"]["transaction"]["parentId"] = json!("statement-credit-two");
    second["intent"]["transaction"]["correlationId"] = json!("statement-correlation-two");
    assert_eq!(
        plan(second.clone())["evidenceReferences"][0]["subjectId"],
        "statement-event-two"
    );
    let mut composite = input.clone();
    composite["intent"] = json!({"kind":"composite","actions":[first["intent"],second["intent"]]});
    let planned = plan(composite.clone());
    assert_eq!(planned["evidenceReferences"].as_array().unwrap().len(), 2);
    assert_eq!(
        verify(verify_request(planned, composite.clone(), "preconditions"))["valid"],
        true
    );
    composite["intent"]["actions"][1]["resolutionSubjectId"] =
        composite["intent"]["actions"][0]["resolutionSubjectId"].clone();
    assert!(
        plan_request(composite).is_err(),
        "same event cannot be consumed twice"
    );
    for selector in ["", "unknown-event"] {
        let mut invalid = first.clone();
        invalid["intent"]["resolutionSubjectId"] = json!(selector);
        assert!(plan_request(invalid).is_err());
    }
}

#[test]
fn independent_identical_events_cannot_supply_one_projection_even_with_distinct_documents() {
    let mut input = shared_statement_credit_request();
    let observations = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap();
    let second = observations.last_mut().unwrap();
    second["evidence"][0]["evidenceId"] = json!("second-document");
    input["resolvedEvidence"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["evidenceId"] = json!("second-document");
    input["intent"]["evidenceIds"]
        .as_array_mut()
        .unwrap()
        .push(json!("second-document"));
    assert!(plan_request(input)
        .unwrap_err()
        .contains("projection_multiple_event_subjects"));
    let mut duplicate = shared_statement_credit_request();
    let repeated = duplicate["resolvedEvidence"]
        .as_array()
        .unwrap()
        .last()
        .unwrap()
        .clone();
    duplicate["resolvedEvidence"]
        .as_array_mut()
        .unwrap()
        .push(repeated);
    assert!(plan_request(duplicate)
        .unwrap_err()
        .contains("invalid_or_duplicate_evidence"));
}

#[test]
fn evidence_subject_selector_is_optional_but_never_nullable() {
    for mut input in [
        evidence_projection_request(),
        evidence_credit_request(),
        evidence_amendment_request(),
    ] {
        assert!(plan_request(input.clone()).is_ok());
        input["intent"]["resolutionSubjectId"] = Value::Null;
        assert!(
            plan_request(input).is_err(),
            "explicit null cannot bypass the strict selector contract"
        );
    }
}

fn wallet_opening_request() -> Value {
    let mut value = request();
    value["intent"] = json!({"kind":"wallet_materialization","walletId":"wallet-new-1","accountName":"Emergency savings","currency":"USD","opening":{"amount":money(1200,"USD"),"date":"2026-09-01","proofSetHash":"a".repeat(64),"activityManifestHash":"b".repeat(64)}});
    value["decisionCardRequest"]["financialSnapshot"]["observations"].as_array_mut().unwrap().push(json!({"kind":"wallet_statement_anchor","version":"wallet-statement-v1","scope":{"kind":"claim","id":"wallet-new-1"},"state":"resolved","observedAt":EVALUATED_AT,"contentHash":"a".repeat(64),"walletBalanceAnchor":{"walletId":"wallet-new-1","amount":money(1200,"USD"),"asOfDate":"2026-09-01","boundary":"before_day_activity","proofIds":["statement-proof"],"proofSetHash":"a".repeat(64),"activityManifestHash":"b".repeat(64),"evidenceIds":["statement-document"]},"evidence":[{"evidenceId":"statement-document","kind":"human_attested_statement","authorized":true,"redaction":"visible"}]}));
    value["resolvedEvidence"].as_array_mut().unwrap().push(json!({"evidenceId":"statement-document","subjectId":"wallet-new-1","state":"resolved","contentHash":"a".repeat(64)}));
    value
}

#[test]
fn nonzero_wallet_opening_requires_exact_current_before_activity_attestation() {
    let value = wallet_opening_request();
    let result =
        plan_request(value.clone()).expect("exact human-attested opening equity is supported");
    assert_eq!(result["action"]["opening"]["amount"], money(1200, "USD"));
    assert!(result["expectedPostconditions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|p| p["kind"] == "wallet_opening_equity" && p["amount"] == money(1200, "USD")));
    assert!(result["evidenceReferences"]
        .as_array()
        .unwrap()
        .iter()
        .any(|e| e["evidenceId"] == "statement-document"));
    for (path, changed) in [
        ("amount", money(0, "USD")),
        ("amount", money(-1, "USD")),
        ("amount", money(1200, "EUR")),
        ("date", json!("2026-09-02")),
        ("proofSetHash", json!("c".repeat(64))),
        ("activityManifestHash", json!("c".repeat(64))),
    ] {
        let mut invalid = value.clone();
        invalid["intent"]["opening"][path] = changed;
        assert!(plan_request(invalid).is_err(), "{path}");
    }
    for (field, changed) in [
        ("boundary", json!("after_day_activity")),
        ("walletId", json!("another-wallet")),
    ] {
        let mut invalid = value.clone();
        let observations = invalid["decisionCardRequest"]["financialSnapshot"]["observations"]
            .as_array_mut()
            .unwrap();
        observations.last_mut().unwrap()["walletBalanceAnchor"][field] = changed;
        assert!(plan_request(invalid).is_err());
    }
    let mut unauthorized = value.clone();
    unauthorized["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["evidence"][0]["authorized"] = json!(false);
    assert!(plan_request(unauthorized).is_err());
    let mut duplicate = value.clone();
    let observations = duplicate["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap();
    observations.push(observations.last().unwrap().clone());
    assert!(plan_request(duplicate).is_ok());
    let mut missing = value;
    missing["resolvedEvidence"] = json!([]);
    assert!(plan_request(missing).is_err());
}

fn apply_wallet_opening_postconditions(value: &mut Value) {
    apply_wallet_postconditions(value, true);
    for account in value["currentLedger"]["accounts"].as_array_mut().unwrap() {
        if account["accountId"] == "actual-wallet-account-1" {
            account["balance"] = money(1200, "USD");
        }
    }
    for account in value["decisionCardRequest"]["financialSnapshot"]["liquidity"]["accounts"]
        .as_array_mut()
        .unwrap()
    {
        if account["accountId"] == "actual-wallet-account-1" {
            account["recordedBalance"] = money(1200, "USD");
        }
    }
    for account in value["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["accounts"]
        .as_array_mut()
        .unwrap()
    {
        if account["id"] == "actual-wallet-account-1" {
            account["clearedBalance"] = money(1200, "USD");
            account["importedBalance"] = money(1200, "USD");
        }
    }
    value["currentLedger"]["transactions"].as_array_mut().unwrap().push(json!({"parentId":"opening-row","accountId":"actual-wallet-account-1","amount":money(1200,"USD"),"date":"2026-09-01","categoryId":null,"payeeName":"Starting Balance","notes":null,"splits":[],"transferAccountId":null}));
    value["currentLedger"]["walletOpeningEquities"] = json!([{"walletId":"wallet-new-1","accountId":"actual-wallet-account-1","transactionId":"opening-row","amount":money(1200,"USD"),"date":"2026-09-01","startingBalance":true,"sdkFingerprint":"c".repeat(64),"payeeId":"starting-payee","categoryId":null}]);
    value["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"].as_array_mut().unwrap().push(json!({"id":"opening-row","accountId":"actual-wallet-account-1","amount":money(1200,"USD"),"date":"2026-09-01","categoryId":null,"categoryName":null,"payeeId":"starting-payee","payeeName":"Starting Balance","notes":null,"cleared":true,"reconciled":false,"importedId":null,"importedPayee":null,"transferAccountId":null,"tags":[],"subtransactions":[]}));
    value["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"].as_array_mut().unwrap().push(json!({"id":"starting-payee","name":"Starting Balance","transferAccountId":null,"mtid":null}));
}
#[test]
fn nonzero_wallet_equity_postconditions_restore_only_exact_native_equity_and_reject_ordinary_credits(
) {
    let before = wallet_opening_request();
    let planned = plan(before.clone());
    let mut after = before.clone();
    apply_wallet_opening_postconditions(&mut after);
    assert_eq!(
        verify(verify_request(
            planned.clone(),
            after.clone(),
            "postconditions"
        ))["valid"],
        true
    );
    for (field, changed) in [
        ("startingBalance", json!(false)),
        ("amount", money(1201, "USD")),
        ("date", json!("2026-09-02")),
        ("sdkFingerprint", json!("bad")),
        ("accountId", json!("checking")),
    ] {
        let mut invalid = after.clone();
        invalid["currentLedger"]["walletOpeningEquities"][0][field] = changed;
        assert_ne!(
            verify(verify_request(planned.clone(), invalid, "postconditions"))["valid"],
            true,
            "{field}"
        );
    }
    for (field, changed) in [
        ("cleared", json!(false)),
        ("notes", json!("changed")),
        ("payeeId", json!("another-payee")),
        ("importedId", json!("external")),
        ("reconciled", json!(true)),
    ] {
        let mut invalid = after.clone();
        invalid["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["transactions"][0]
            [field] = changed;
        assert_ne!(
            verify(verify_request(planned.clone(), invalid, "postconditions"))["valid"],
            true,
            "{field}"
        );
    }
    let mut missing = after.clone();
    missing["currentLedger"]
        .as_object_mut()
        .unwrap()
        .remove("walletOpeningEquities");
    assert_ne!(
        verify(verify_request(planned.clone(), missing, "postconditions"))["valid"],
        true
    );
    let mut unrelated = after;
    unrelated["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"]["payees"]
        .as_array_mut()
        .unwrap()
        .push(
            json!({"id":"unrelated","name":"Other new payee","transferAccountId":null,"mtid":null}),
        );
    assert_ne!(
        verify(verify_request(planned, unrelated, "postconditions"))["valid"],
        true
    );
}

#[test]
fn independent_wallet_openings_share_only_the_sdk_created_starting_balance_payee() {
    let mut before = wallet_opening_request();
    let mut second = before["intent"].clone();
    second["walletId"] = json!("wallet-new-2");
    second["accountName"] = json!("Reserve cash");
    second["opening"]["amount"] = money(800, "USD");
    before["intent"] = json!({"kind":"composite","actions":[before["intent"].clone(),second]});
    let observations = before["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap();
    let mut anchor = observations.last().unwrap().clone();
    anchor["scope"]["id"] = json!("wallet-new-2");
    anchor["walletBalanceAnchor"]["walletId"] = json!("wallet-new-2");
    anchor["walletBalanceAnchor"]["amount"] = money(800, "USD");
    anchor["walletBalanceAnchor"]["evidenceIds"] = json!(["second-document"]);
    anchor["evidence"][0]["evidenceId"] = json!("second-document");
    observations.push(anchor);
    before["resolvedEvidence"].as_array_mut().unwrap().push(json!({"evidenceId":"second-document","subjectId":"wallet-new-2","state":"resolved","contentHash":"a".repeat(64)}));
    let planned = plan(before.clone());
    let mut after = before;
    apply_wallet_opening_postconditions(&mut after);
    for (collection, id_key) in [
        ("accounts", "accountId"),
        ("transactions", "parentId"),
        ("walletOpeningEquities", "accountId"),
    ] {
        let rows = after["currentLedger"][collection].as_array_mut().unwrap();
        let mut row = rows.last().unwrap().clone();
        row[id_key] = json!(if collection == "transactions" {
            "opening-row-2"
        } else {
            "actual-wallet-account-2"
        });
        if collection == "accounts" {
            row["name"] = json!("Reserve cash");
            row["balance"] = money(800, "USD");
        } else {
            row["accountId"] = json!("actual-wallet-account-2");
            row["amount"] = money(800, "USD");
            if collection == "walletOpeningEquities" {
                row["walletId"] = json!("wallet-new-2");
                row["transactionId"] = json!("opening-row-2");
            }
        }
        rows.push(row);
    }
    after["currentLedger"]["wallets"]
        .as_array_mut()
        .unwrap()
        .push(json!({"walletId":"wallet-new-2","accountId":"actual-wallet-account-2"}));
    let facts = after["decisionCardRequest"]["financialSnapshot"]["liquidity"]["accounts"]
        .as_array_mut()
        .unwrap();
    let mut fact = facts.last().unwrap().clone();
    fact["accountId"] = json!("actual-wallet-account-2");
    fact["recordedBalance"] = money(800, "USD");
    facts.push(fact);
    for collection in ["accounts", "transactions", "payees"] {
        let rows = after["decisionCardRequest"]["financialSnapshot"]["legacySnapshot"][collection]
            .as_array_mut()
            .unwrap();
        let mut row = if collection == "payees" {
            rows.iter()
                .find(|row| row["transferAccountId"] == "actual-wallet-account-1")
                .unwrap()
                .clone()
        } else {
            rows.last().unwrap().clone()
        };
        match collection {
            "accounts" => {
                row["id"] = json!("actual-wallet-account-2");
                row["name"] = json!("Reserve cash");
                row["clearedBalance"] = money(800, "USD");
                row["importedBalance"] = money(800, "USD");
            }
            "transactions" => {
                row["id"] = json!("opening-row-2");
                row["accountId"] = json!("actual-wallet-account-2");
                row["amount"] = money(800, "USD");
            }
            _ => {
                row["id"] = json!("actual-wallet-transfer-payee-2");
                row["name"] = json!("Reserve cash");
                row["transferAccountId"] = json!("actual-wallet-account-2");
            }
        }
        rows.push(row);
    }
    assert_eq!(
        verify(verify_request(planned, after, "postconditions"))["valid"],
        true
    );
}

#[test]
fn nonzero_opening_selects_exact_native_boundary_among_other_valid_boundaries() {
    let mut input = wallet_opening_request();
    let entries = input["decisionCardRequest"]["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap();
    let mut after = entries.last().unwrap().clone();
    after["walletBalanceAnchor"]["boundary"] = json!("after_day_activity");
    after["walletBalanceAnchor"]["asOfDate"] = json!("2026-09-02");
    entries.push(after);
    let duplicate = entries[entries.len() - 2].clone();
    entries.push(duplicate);
    assert!(plan_request(input).is_ok());
}
