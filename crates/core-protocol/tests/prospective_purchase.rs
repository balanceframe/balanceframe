use balanceframe_core_protocol::{
    evaluate_prospective_claims, evaluate_prospective_purchase, DecisionContext, DecisionIssueCode,
    DecisionIssueEffect, DecisionIssueSeverity, DecisionReadiness, DecisionScope,
    FinancialSnapshot, ProspectiveClaim, ProspectivePurchaseEvaluationRequest,
    PurchaseEvaluationRequest, RedactionState,
};
use balanceframe_financial_core::{
    BudgetCategory, BudgetMonth, Category, Money, PendingMode, Transaction,
};
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
    let issue = decision
        .issues
        .iter()
        .find(|issue| issue.code == DecisionIssueCode::CurrencyMismatch)
        .expect("currency mismatch must be explicit");
    assert_eq!(issue.severity, DecisionIssueSeverity::Critical);
    assert_eq!(issue.effect, DecisionIssueEffect::Blocks);
    assert_eq!(issue.scope, DecisionScope::Category(CATEGORY_ID.into()));
    assert!(issue.blocks_conclusion());
    let remediation = issue
        .remediation
        .as_ref()
        .expect("currency mismatch must explain the compatible-currency action");
    assert_eq!(remediation.code, "use_compatible_currency");
    assert_eq!(
        remediation.action,
        "Use an account and category with the purchase currency."
    );
    assert_eq!(decision.payload.category_budget, Money::new(10_000, "USD"));
    assert_eq!(
        decision.payload.category_remaining,
        Money::new(10_000, "USD")
    );
    assert!(
        decision.before.amounts.is_empty(),
        "a currency mismatch must not expose a before amount in the category currency"
    );
    assert!(
        decision.after.amounts.is_empty(),
        "a currency mismatch must not expose an after amount in the purchase currency"
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

#[test]
fn supplied_pending_policy_changes_the_purchase_calculation() {
    let mut snapshot = financial_snapshot();
    let mut pending = proposed_purchase("USD");
    pending.id = "fd-pending-policy-input".into();
    pending.amount = Money::new(-1_000, "USD");
    snapshot.legacy_snapshot.transactions.push(pending);

    let included = evaluate_prospective_purchase(request(
        snapshot.clone(),
        context(),
        vec![],
        proposed_purchase("USD"),
    ));
    let mut exclude_context = context();
    exclude_context.policy.pending_mode = PendingMode::Exclude;
    let excluded = evaluate_prospective_purchase(request(
        snapshot,
        exclude_context,
        vec![],
        proposed_purchase("USD"),
    ));

    assert_eq!(included.payload.category_spent, Money::new(1_000, "USD"));
    assert_eq!(
        included.payload.category_remaining,
        Money::new(9_000, "USD")
    );
    assert_eq!(
        included.payload.projected_balance,
        Some(Money::new(124_000, "USD"))
    );
    assert!(included
        .payload
        .reason_codes
        .iter()
        .any(|reason| reason == "pending_exposure"));

    assert_eq!(excluded.payload.category_spent, Money::new(0, "USD"));
    assert_eq!(
        excluded.payload.category_remaining,
        Money::new(10_000, "USD")
    );
    assert_eq!(
        excluded.payload.projected_balance,
        Some(Money::new(125_000, "USD"))
    );
    assert!(!excluded
        .payload
        .reason_codes
        .iter()
        .any(|reason| reason == "pending_exposure"));
}

#[test]
fn supplied_account_override_excludes_the_purchase_account() {
    let baseline = evaluate_prospective_purchase(request(
        financial_snapshot(),
        context(),
        vec![],
        proposed_purchase("USD"),
    ));
    let mut excluded_context = context();
    excluded_context
        .policy
        .account_overrides
        .exclude
        .push(ACCOUNT_ID.into());

    let excluded = evaluate_prospective_purchase(request(
        financial_snapshot(),
        excluded_context,
        vec![],
        proposed_purchase("USD"),
    ));

    assert_eq!(
        baseline.payload.projected_balance,
        Some(Money::new(125_000, "USD"))
    );
    assert!(baseline.payload.allowable);
    assert_eq!(excluded.payload.projected_balance, None);
    assert!(!excluded.payload.allowable);
    assert_eq!(
        excluded.payload.reason_codes,
        vec!["account_unavailable".to_string()]
    );
}

#[test]
fn supplied_snapshot_freshness_limit_blocks_stale_input() {
    let mut snapshot = financial_snapshot();
    snapshot.captured_at = "2026-08-23T10:00:00Z".into();
    let mut stale_context = context();
    stale_context.policy.max_budget_snapshot_age_minutes = Some(30);

    let decision = evaluate_prospective_purchase(request(
        snapshot,
        stale_context,
        vec![],
        proposed_purchase("USD"),
    ));

    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
    assert!(!decision.payload.allowable);
    assert!(decision
        .payload
        .reason_codes
        .iter()
        .any(|reason| reason == "stale_snapshot"));
}

#[test]
fn consistently_eur_purchase_remains_ready_and_never_manufactures_usd_money() {
    let mut snapshot = financial_snapshot();
    for account in &mut snapshot.legacy_snapshot.accounts {
        account.cleared_balance = Money::new(account.cleared_balance.minor_units(), "EUR");
        account.imported_balance = Money::new(account.imported_balance.minor_units(), "EUR");
    }
    for budget in &mut snapshot.legacy_snapshot.budgets {
        for category in budget.categories.values_mut() {
            category.amount = Money::new(category.amount.minor_units(), "EUR");
            category.carryover = Money::new(category.carryover.minor_units(), "EUR");
            category.carryover_from_previous =
                Money::new(category.carryover_from_previous.minor_units(), "EUR");
        }
    }

    let decision = evaluate_prospective_purchase(request(
        snapshot,
        context(),
        vec![],
        proposed_purchase("EUR"),
    ));

    assert_eq!(decision.readiness, DecisionReadiness::Ready);
    assert!(decision.issues.is_empty());
    assert!(decision.payload.allowable);
    let payload_money = [
        &decision.payload.category_budget,
        &decision.payload.category_spent,
        &decision.payload.category_remaining,
        decision
            .payload
            .projected_balance
            .as_ref()
            .expect("a covered EUR account must retain its projected balance"),
    ];
    assert!(payload_money
        .iter()
        .all(|amount| amount.currency() == "EUR"));
    assert!(decision
        .before
        .amounts
        .iter()
        .chain(decision.after.amounts.iter())
        .all(|amount| amount.amount.currency() == "EUR"));
}

#[test]
fn relevant_source_observations_become_scoped_blocking_issues_with_remediation() {
    let mut snapshot = financial_snapshot();
    let mut transfer_candidate = proposed_purchase("USD");
    transfer_candidate.id = "fd-transfer-candidate".into();
    transfer_candidate.amount = Money::new(-100, "USD");
    transfer_candidate.cleared = true;
    transfer_candidate.reconciled = true;
    snapshot
        .legacy_snapshot
        .transactions
        .push(transfer_candidate);
    snapshot.observations = serde_json::from_value(json!([
        {
            "kind": "account_freshness",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "state": "stale",
            "observedAt": "2026-08-23T10:00:00Z",
            "evidence": []
        },
        {
            "kind": "schedule_coverage",
            "scope": { "kind": "schedule", "id": "fd-schedule-card-payment" },
            "state": "unavailable",
            "observedAt": null,
            "evidence": []
        },
        {
            "kind": "transfer_ambiguity",
            "scope": { "kind": "transaction", "id": "fd-transfer-candidate" },
            "state": "ambiguous",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": []
        },
        {
            "kind": "currency_compatibility",
            "scope": { "kind": "category", "id": CATEGORY_ID },
            "state": "incompatible",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": []
        }
    ]))
    .expect("test observations must satisfy the canonical contract");

    let decision = evaluate_prospective_purchase(request(
        snapshot,
        context(),
        vec![],
        proposed_purchase("USD"),
    ));

    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
    assert_eq!(
        serde_json::to_value(&decision.issues).expect("issues serialize"),
        json!([
            {
                "code": "account_freshness_coverage",
                "severity": "warning",
                "effect": "blocks",
                "scope": { "kind": "account", "id": ACCOUNT_ID },
                "evidence": [],
                "remediation": {
                    "code": "refresh_account_evidence",
                    "action": "Refresh the affected account before evaluating again."
                },
                "redaction": "visible"
            },
            {
                "code": "schedule_coverage",
                "severity": "critical",
                "effect": "blocks",
                "scope": { "kind": "schedule", "id": "fd-schedule-card-payment" },
                "evidence": [],
                "remediation": {
                    "code": "reconnect_source",
                    "action": "Reconnect or refresh the affected source before evaluating again."
                },
                "redaction": "visible"
            },
            {
                "code": "duplicate_transfer_ambiguity",
                "severity": "warning",
                "effect": "blocks",
                "scope": { "kind": "transaction", "id": "fd-transfer-candidate" },
                "evidence": [],
                "remediation": {
                    "code": "review_transfer",
                    "action": "Review the related transactions and resolve the transfer ambiguity."
                },
                "redaction": "visible"
            },
            {
                "code": "currency_mismatch",
                "severity": "critical",
                "effect": "blocks",
                "scope": { "kind": "category", "id": CATEGORY_ID },
                "evidence": [],
                "remediation": {
                    "code": "use_compatible_currency",
                    "action": "Use an account and category with the purchase currency."
                },
                "redaction": "visible"
            }
        ])
    );
}

#[test]
fn authorized_but_redacted_references_never_enter_top_level_evidence() {
    let mut snapshot = financial_snapshot();
    snapshot.observations = serde_json::from_value(json!([{
        "kind": "account_freshness",
        "scope": { "kind": "account", "id": ACCOUNT_ID },
        "state": "fresh",
        "observedAt": "2026-08-23T12:00:00Z",
        "evidence": [{
            "evidenceId": "private-bank-sync-record-884",
            "kind": "bank_sync",
            "authorized": true,
            "redaction": "redacted"
        }]
    }]))
    .expect("redacted observation must satisfy the canonical contract");

    let decision = evaluate_prospective_purchase(request(
        snapshot,
        context(),
        vec![],
        proposed_purchase("USD"),
    ));

    assert_eq!(decision.readiness, DecisionReadiness::Ready);
    assert!(decision.evidence.is_empty());
    let serialized = serde_json::to_string(&decision.evidence).expect("evidence serializes");
    assert!(!serialized.contains("private-bank-sync-record-884"));
}

#[test]
fn top_level_evidence_keeps_selected_balance_and_issue_proof_without_copying_activity_rows() {
    let mut snapshot = financial_snapshot();
    let mut unrelated_transaction = proposed_purchase("USD");
    unrelated_transaction.id = "fd-unrelated-transaction".into();
    unrelated_transaction.category_id = Some("fd-category-travel".into());
    unrelated_transaction.category_name = Some("Travel".into());
    unrelated_transaction.account_id = "fd-account-card".into();
    snapshot
        .legacy_snapshot
        .transactions
        .push(unrelated_transaction);
    snapshot.observations = serde_json::from_value(json!([
        {
            "kind": "account_freshness",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "state": "fresh",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": [{
                "evidenceId": "fd-selected-account-proof",
                "kind": "bank_sync",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "account_balance",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "state": "complete",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": [{
                "evidenceId": "fd-selected-balance-proof",
                "kind": "balance_record",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "pending_activity",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "state": "included",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": [{
                "evidenceId": "fd-ordinary-pending-row",
                "kind": "transaction_record",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "uncleared_activity",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "state": "included",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": [{
                "evidenceId": "fd-ordinary-uncleared-row",
                "kind": "transaction_record",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "pending_activity",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "state": "unavailable",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": [{
                "evidenceId": "fd-pending-availability-issue-proof",
                "kind": "source_observation",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "account_freshness",
            "scope": { "kind": "account", "id": "fd-account-card" },
            "state": "fresh",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": [{
                "evidenceId": "fd-unrelated-account-proof",
                "kind": "bank_sync",
                "authorized": true,
                "redaction": "visible"
            }]
        },
        {
            "kind": "pending_activity",
            "scope": { "kind": "transaction", "id": "fd-unrelated-transaction" },
            "state": "included",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": [{
                "evidenceId": "fd-unrelated-transaction-proof",
                "kind": "transaction_record",
                "authorized": true,
                "redaction": "visible"
            }]
        }
    ]))
    .expect("test observations must satisfy the canonical contract");

    let decision = evaluate_prospective_purchase(request(
        snapshot,
        context(),
        vec![],
        proposed_purchase("USD"),
    ));

    let evidence_ids: Vec<&str> = decision
        .evidence
        .iter()
        .map(|reference| reference.evidence_id.as_str())
        .collect();
    assert_eq!(
        evidence_ids.len(),
        3,
        "primary evidence must remain compact"
    );
    assert!(evidence_ids.contains(&"fd-selected-account-proof"));
    assert!(evidence_ids.contains(&"fd-selected-balance-proof"));
    assert!(evidence_ids.contains(&"fd-pending-availability-issue-proof"));
    assert!(!evidence_ids.contains(&"fd-ordinary-pending-row"));
    assert!(!evidence_ids.contains(&"fd-ordinary-uncleared-row"));
    assert!(!evidence_ids.contains(&"fd-unrelated-account-proof"));
    assert!(!evidence_ids.contains(&"fd-unrelated-transaction-proof"));

    let pending_issue = decision
        .issues
        .iter()
        .find(|issue| issue.code == DecisionIssueCode::PendingAvailability)
        .expect("unavailable selected-account pending activity must remain a decision issue");
    assert!(pending_issue
        .evidence
        .iter()
        .any(|reference| reference.evidence_id == "fd-pending-availability-issue-proof"));
}

#[test]
fn account_scoped_claims_outside_the_effective_account_policy_are_fully_ineligible() {
    let mut excluded_one = fixture_claim("fd-claim-active-reservation");
    excluded_one.claim_id = "fd-claim-excluded-account-one".into();
    excluded_one.source_id = "fd-source-excluded-account-one".into();
    excluded_one.scope = DecisionScope::Account("fd-account-card".into());
    excluded_one.amount = Money::new(300, "USD");
    let mut excluded_two = excluded_one.clone();
    excluded_two.claim_id = "fd-claim-excluded-account-two".into();
    excluded_two.source_id = "fd-source-excluded-account-two".into();
    excluded_two.amount = Money::new(400, "USD");

    let category_claim = fixture_claim("fd-claim-active-reservation");
    let mut global_claim = category_claim.clone();
    global_claim.claim_id = "fd-claim-global-reservation".into();
    global_claim.source_id = "fd-source-global-reservation".into();
    global_claim.scope = DecisionScope::Global;
    global_claim.amount = Money::new(200, "USD");
    let claims = vec![excluded_one, excluded_two, category_claim, global_claim];

    let mut exclude_context = context();
    exclude_context
        .policy
        .account_overrides
        .exclude
        .push("fd-account-card".into());
    let mut include_only_context = context();
    include_only_context.policy.account_overrides.include_only = Some(vec![ACCOUNT_ID.into()]);

    for policy_context in [exclude_context, include_only_context] {
        let evaluation = evaluate_prospective_claims(&policy_context, &claims);
        assert_eq!(
            evaluation.eligible_claim_ids,
            vec![
                "fd-claim-active-reservation".to_string(),
                "fd-claim-global-reservation".to_string()
            ]
        );
        assert_eq!(evaluation.reservation_total, Some(Money::new(1_200, "USD")));
        assert_eq!(evaluation.commitment_total, None);
        assert!(
            evaluation.issues.is_empty(),
            "ineligible account claims must not create scope conflicts or claim evidence"
        );

        let decision = evaluate_prospective_purchase(request(
            financial_snapshot(),
            policy_context,
            claims.clone(),
            proposed_purchase("USD"),
        ));
        assert_eq!(decision.readiness, DecisionReadiness::Ready);
        assert_eq!(decision.before.amounts[0].amount, Money::new(9_000, "USD"));
        assert_eq!(decision.after.amounts[0].amount, Money::new(6_500, "USD"));
        assert!(decision
            .issues
            .iter()
            .all(|issue| issue.code != DecisionIssueCode::ReservationConflict));
        assert!(decision.evidence.iter().all(|reference| {
            reference.evidence_id != "fd-source-excluded-account-one"
                && reference.evidence_id != "fd-source-excluded-account-two"
        }));
    }
}

#[test]
fn unavailable_account_type_qualifies_the_relevant_purchase_with_exact_remediation() {
    let mut snapshot = financial_snapshot();
    snapshot.observations = serde_json::from_value(json!([{
        "kind": "account_type",
        "scope": { "kind": "account", "id": ACCOUNT_ID },
        "state": "unavailable",
        "observedAt": null,
        "evidence": []
    }]))
    .expect("account type observation must satisfy the canonical contract");

    let decision = evaluate_prospective_purchase(request(
        snapshot,
        context(),
        vec![],
        proposed_purchase("USD"),
    ));

    assert_eq!(decision.readiness, DecisionReadiness::Qualified);
    assert_eq!(
        serde_json::to_value(&decision.issues).expect("issues serialize"),
        json!([{
            "code": "account_freshness_coverage",
            "severity": "warning",
            "effect": "qualifies",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "evidence": [],
            "remediation": {
                "code": "reconnect_source",
                "action": "Reconnect or refresh the affected source before evaluating again."
            },
            "redaction": "visible"
        }])
    );
}

#[test]
fn adapter_duplicate_balance_and_reconciliation_observations_block_with_exact_issues() {
    let mut snapshot = financial_snapshot();
    let mut duplicate_candidate = proposed_purchase("USD");
    duplicate_candidate.id = "fd-duplicate-candidate".into();
    duplicate_candidate.amount = Money::new(-100, "USD");
    duplicate_candidate.cleared = true;
    duplicate_candidate.reconciled = true;
    snapshot
        .legacy_snapshot
        .transactions
        .push(duplicate_candidate);
    snapshot.observations = serde_json::from_value(json!([
        {
            "kind": "duplicate_candidate",
            "scope": { "kind": "transaction", "id": "fd-duplicate-candidate" },
            "state": "present",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": []
        },
        {
            "kind": "account_balance",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "state": "unavailable",
            "observedAt": null,
            "evidence": []
        },
        {
            "kind": "reconciliation",
            "scope": { "kind": "account", "id": ACCOUNT_ID },
            "state": "unreconciled",
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": []
        }
    ]))
    .expect("adapter observations must satisfy the canonical contract");

    let decision = evaluate_prospective_purchase(request(
        snapshot,
        context(),
        vec![],
        proposed_purchase("USD"),
    ));

    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
    assert_eq!(
        serde_json::to_value(&decision.issues).expect("issues serialize"),
        json!([
            {
                "code": "duplicate_transfer_ambiguity",
                "severity": "warning",
                "effect": "blocks",
                "scope": { "kind": "transaction", "id": "fd-duplicate-candidate" },
                "evidence": [],
                "remediation": {
                    "code": "review_transfer",
                    "action": "Review the related transactions and resolve the transfer ambiguity."
                },
                "redaction": "visible"
            },
            {
                "code": "account_freshness_coverage",
                "severity": "critical",
                "effect": "blocks",
                "scope": { "kind": "account", "id": ACCOUNT_ID },
                "evidence": [],
                "remediation": {
                    "code": "reconnect_source",
                    "action": "Reconnect or refresh the affected source before evaluating again."
                },
                "redaction": "visible"
            },
            {
                "code": "economic_event_ambiguity",
                "severity": "warning",
                "effect": "blocks",
                "scope": { "kind": "account", "id": ACCOUNT_ID },
                "evidence": [],
                "remediation": {
                    "code": "review_material_evidence",
                    "action": "Review the supporting evidence before evaluating again."
                },
                "redaction": "visible"
            }
        ])
    );
}
