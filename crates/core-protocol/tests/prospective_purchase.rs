use balanceframe_core_protocol::{
    evaluate_prospective_purchase, DecisionContext, DecisionIssueCode, DecisionReadiness,
    FinancialSnapshot, ProspectiveClaim, ProspectivePurchaseEvaluationRequest,
    PurchaseEvaluationRequest, RedactionState,
};
use balanceframe_financial_core::{BudgetCategory, BudgetMonth, Category, Money, Transaction};
use serde_json::{json, Value};
use std::collections::HashMap;

const FIXTURE: &str = include_str!("../../../protocol/fixtures/financial-decision-foundation.json");
const CATEGORY_ID: &str = "fd-category-groceries";
const ACCOUNT_ID: &str = "fd-account-checking";
const VALID_UNTIL: &str = "2026-08-23T12:15:00Z";

fn fixture() -> Value {
    serde_json::from_str(FIXTURE).expect("financial-decision fixture must be valid JSON")
}

fn financial_snapshot() -> FinancialSnapshot {
    let mut snapshot: FinancialSnapshot = serde_json::from_value(fixture()["full"].clone())
        .expect("fixture full snapshot must satisfy the canonical Rust contract");

    snapshot.legacy_snapshot.transactions.clear();
    snapshot.legacy_snapshot.categories = vec![Category {
        id: CATEGORY_ID.into(),
        name: "Groceries".into(),
        group_name: Some("Everyday".into()),
        is_income: false,
        mtid: None,
        deleted: false,
    }];
    snapshot.legacy_snapshot.budgets = vec![BudgetMonth {
        id: "fd-budget-2026-08".into(),
        month: "2026-08".into(),
        categories: HashMap::from([(
            CATEGORY_ID.into(),
            BudgetCategory {
                category_id: CATEGORY_ID.into(),
                amount: Money::new(10_000, "USD"),
                carryover: Money::new(0, "USD"),
                carryover_from_previous: Money::new(0, "USD"),
                carries_over: false,
            },
        )]),
    }];
    snapshot.observations.retain(|observation| {
        serde_json::to_value(&observation.scope).expect("scope serializes")
            == json!({ "kind": "account", "id": ACCOUNT_ID })
            && serde_json::to_value(observation.kind).expect("kind serializes")
                == json!("account_freshness")
    });
    snapshot
}

fn context() -> DecisionContext {
    serde_json::from_value(fixture()["claims"]["context"].clone())
        .expect("fixture decision context must satisfy the Rust contract")
}

fn fixture_claim(claim_id: &str) -> ProspectiveClaim {
    fixture()["claims"]["items"]
        .as_array()
        .expect("fixture claims are an array")
        .iter()
        .find(|claim| claim["claimId"] == claim_id)
        .cloned()
        .map(serde_json::from_value)
        .expect("fixture claim must exist")
        .expect("fixture claim must satisfy the Rust contract")
}

fn proposed_purchase(currency: &str) -> Transaction {
    Transaction {
        id: "fd-proposed-purchase".into(),
        account_id: ACCOUNT_ID.into(),
        date: "2026-08-23".into(),
        payee_id: None,
        payee_name: Some("Fixture Grocer".into()),
        category_id: Some(CATEGORY_ID.into()),
        category_name: Some("Groceries".into()),
        amount: Money::new(-2_500, currency),
        cleared: false,
        reconciled: false,
        imported_id: None,
        imported_payee: None,
        notes: None,
        tags: vec![],
        transfer_account_id: None,
        subtransactions: vec![],
    }
}

fn request(
    financial_snapshot: FinancialSnapshot,
    context: DecisionContext,
    claims: Vec<ProspectiveClaim>,
    proposed_transaction: Transaction,
) -> ProspectivePurchaseEvaluationRequest {
    ProspectivePurchaseEvaluationRequest {
        financial_snapshot,
        context,
        claims,
        proposed_transaction,
        category_id: CATEGORY_ID.into(),
        request_id: "fd-request-ready".into(),
        correlation_id: "fd-correlation-2026-08-23".into(),
        decision_id: "fd-decision-ready".into(),
        valid_until: VALID_UNTIL.into(),
        redaction: RedactionState::Redacted,
    }
}

#[test]
fn prospective_purchase_is_deterministic_wraps_legacy_and_does_not_mutate_snapshot() {
    let snapshot = financial_snapshot();
    let original_snapshot = snapshot.clone();
    let proposed = proposed_purchase("USD");
    let fixed_context = context();
    let legacy = balanceframe_core_protocol::evaluate_purchase(PurchaseEvaluationRequest {
        snapshot: snapshot.legacy_snapshot.clone(),
        proposed_transaction: proposed.clone(),
        category_id: CATEGORY_ID.into(),
    });

    let first = evaluate_prospective_purchase(request(
        snapshot.clone(),
        fixed_context.clone(),
        vec![],
        proposed.clone(),
    ));
    let second =
        evaluate_prospective_purchase(request(snapshot.clone(), fixed_context, vec![], proposed));

    assert_eq!(
        snapshot, original_snapshot,
        "evaluation must not mutate its input"
    );
    assert_eq!(first, second, "fixed inputs must produce a fixed decision");
    assert_eq!(
        first.payload, legacy,
        "the legacy payload must be byte-for-byte compatible"
    );
    assert_eq!(
        serde_json::to_value(first).expect("decision serializes"),
        json!({
            "metadata": {
                "contractVersion": "1.0",
                "decisionId": "fd-decision-ready",
                "decisionKind": "purchase",
                "requestId": "fd-request-ready",
                "correlationId": "fd-correlation-2026-08-23",
                "context": serde_json::to_value(context()).unwrap()
            },
            "readiness": "ready",
            "before": {
                "amounts": [{
                    "label": "envelopeAvailability",
                    "scope": { "kind": "category", "id": CATEGORY_ID },
                    "amount": { "minorUnits": "10000", "currency": "USD" }
                }]
            },
            "after": {
                "amounts": [{
                    "label": "envelopeAvailability",
                    "scope": { "kind": "category", "id": CATEGORY_ID },
                    "amount": { "minorUnits": "7500", "currency": "USD" }
                }]
            },
            "issues": [],
            "evidence": [{
                "evidenceId": "fd-bank-sync-checking-884",
                "kind": "bank_sync",
                "authorized": true,
                "redaction": "visible"
            }],
            "alternatives": [],
            "expiresAt": VALID_UNTIL,
            "redaction": "redacted",
            "payload": {
                "allowable": true,
                "reasonCodes": ["within_budget", "budget_sufficient"],
                "categoryBudget": { "minorUnits": "10000", "currency": "USD" },
                "categorySpent": { "minorUnits": "0", "currency": "USD" },
                "categoryRemaining": { "minorUnits": "10000", "currency": "USD" },
                "projectedBalance": { "minorUnits": "125000", "currency": "USD" }
            }
        })
    );
}
#[test]
fn incompatible_purchase_currency_blocks_without_fabricating_zero_money() {
    let decision = evaluate_prospective_purchase(request(
        financial_snapshot(),
        context(),
        vec![],
        proposed_purchase("EUR"),
    ));

    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
    assert!(decision.issues.iter().any(
        |issue| issue.code == DecisionIssueCode::CurrencyMismatch && issue.blocks_conclusion()
    ));
    assert_eq!(decision.payload.category_budget, Money::new(10_000, "USD"));
    assert_eq!(
        decision.payload.category_remaining,
        Money::new(10_000, "USD")
    );
}

#[test]
fn prospective_purchase_carries_claim_identity_issues_into_the_decision() {
    let decision = evaluate_prospective_purchase(request(
        financial_snapshot(),
        context(),
        vec![
            fixture_claim("fd-claim-policy-mismatch"),
            fixture_claim("fd-claim-snapshot-mismatch"),
        ],
        proposed_purchase("USD"),
    ));

    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
    assert!(decision.issues.iter().any(|issue| {
        issue.code == DecisionIssueCode::Unknown("policy_version_mismatch".into())
            && issue.blocks_conclusion()
    }));
    assert!(decision.issues.iter().any(|issue| {
        issue.code == DecisionIssueCode::Unknown("snapshot_mismatch".into())
            && issue.blocks_conclusion()
    }));
}

#[test]
fn decision_context_must_name_the_supplied_canonical_snapshot() {
    let mut mismatched = context();
    mismatched.snapshot_id = "fd-snapshot-stale".into();
    mismatched.content_hash = "sha256:stale-content".into();

    let decision = evaluate_prospective_purchase(request(
        financial_snapshot(),
        mismatched.clone(),
        vec![],
        proposed_purchase("USD"),
    ));

    assert_eq!(decision.metadata.context, mismatched);
    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
    assert!(decision.issues.iter().any(|issue| {
        issue.code == DecisionIssueCode::Unknown("snapshot_mismatch".into())
            && issue.blocks_conclusion()
    }));
    assert!(decision.issues.iter().any(|issue| {
        issue.code == DecisionIssueCode::Unknown("content_hash_mismatch".into())
            && issue.blocks_conclusion()
    }));
}
