use balanceframe_core_protocol::{
    evaluate_prospective_claims, evaluate_prospective_purchase, DecisionContext, DecisionIssueCode,
    DecisionIssueEffect, DecisionIssueSeverity, DecisionReadiness, DecisionScope,
    FinancialSnapshot, ProspectiveClaim, ProspectivePurchaseEvaluationRequest, RedactionState,
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
        liquidity: None,
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
fn prospective_purchase_without_liquidity_is_deterministic_and_conservative() {
    let input = request(
        financial_snapshot(),
        context(),
        vec![],
        proposed_purchase("USD"),
    );
    let first = evaluate_prospective_purchase(input.clone());
    let second = evaluate_prospective_purchase(input);
    assert_eq!(first, second, "fixed inputs must produce a fixed decision");
    assert!(!first.payload.allowable);
    assert_eq!(first.readiness, DecisionReadiness::Blocked);
    assert_eq!(first.before.amounts[0].amount, Money::new(10_000, "USD"));
    assert_eq!(first.after.amounts[0].amount, Money::new(7_500, "USD"));
    let account_aware = first.payload.account_aware.unwrap();
    assert_eq!(
        account_aware.payment_liquidity_status,
        balanceframe_core_protocol::PaymentLiquidityStatus::InsufficientData
    );
    assert!(account_aware
        .purchases
        .iter()
        .all(|purchase| purchase.transfer_plan.is_none()));
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
        Some(Money::new(121_500, "USD"))
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
        Some(Money::new(122_500, "USD"))
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
        Some(Money::new(122_500, "USD"))
    );
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

    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
    assert!(!decision.payload.allowable);
    assert!(decision
        .issues
        .iter()
        .all(|issue| issue.code != DecisionIssueCode::CurrencyMismatch));
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
    for (code, scope, remediation) in [
        (
            DecisionIssueCode::AccountFreshnessCoverage,
            DecisionScope::Account(ACCOUNT_ID.into()),
            "refresh_account_evidence",
        ),
        (
            DecisionIssueCode::ScheduleCoverage,
            DecisionScope::Schedule("fd-schedule-card-payment".into()),
            "reconnect_source",
        ),
        (
            DecisionIssueCode::DuplicateTransferAmbiguity,
            DecisionScope::Transaction("fd-transfer-candidate".into()),
            "review_transfer",
        ),
        (
            DecisionIssueCode::CurrencyMismatch,
            DecisionScope::Category(CATEGORY_ID.into()),
            "use_compatible_currency",
        ),
    ] {
        let issue = decision
            .issues
            .iter()
            .find(|issue| issue.code == code && issue.scope == scope)
            .expect("relevant observation must retain its scoped blocker");
        assert_eq!(issue.effect, DecisionIssueEffect::Blocks);
        assert_eq!(
            issue.remediation.as_ref().map(|value| value.code.as_str()),
            Some(remediation)
        );
    }
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

    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
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
        assert_eq!(decision.readiness, DecisionReadiness::Blocked);
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
fn unavailable_account_type_retains_scoped_remediation_without_claiming_liquidity() {
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

    assert_eq!(decision.readiness, DecisionReadiness::Blocked);
    let issue = decision
        .issues
        .iter()
        .find(|issue| issue.code == DecisionIssueCode::AccountFreshnessCoverage)
        .expect("unavailable account type must remain visible");
    assert_eq!(issue.scope, DecisionScope::Account(ACCOUNT_ID.into()));
    assert_eq!(issue.effect, DecisionIssueEffect::Qualifies);
    assert_eq!(
        issue.remediation.as_ref().map(|value| value.code.as_str()),
        Some("reconnect_source")
    );
}

#[test]
fn adapter_duplicate_balance_and_reconciliation_observations_remain_scoped_blockers() {
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
    for (code, scope) in [
        (
            DecisionIssueCode::DuplicateTransferAmbiguity,
            DecisionScope::Transaction("fd-duplicate-candidate".into()),
        ),
        (
            DecisionIssueCode::AccountFreshnessCoverage,
            DecisionScope::Account(ACCOUNT_ID.into()),
        ),
        (
            DecisionIssueCode::EconomicEventAmbiguity,
            DecisionScope::Account(ACCOUNT_ID.into()),
        ),
    ] {
        assert!(decision.issues.iter().any(|issue| issue.code == code
            && issue.scope == scope
            && issue.effect == DecisionIssueEffect::Blocks));
    }
}

#[test]
fn canonical_purchase_rejects_unbound_identity_and_expired_validity() {
    let valid = request(
        financial_snapshot(),
        context(),
        vec![],
        proposed_purchase("USD"),
    );
    for (pointer, value, code) in [
        ("/requestId", json!(" "), "invalid_request_identity"),
        ("/correlationId", json!(""), "invalid_request_identity"),
        ("/decisionId", json!(""), "invalid_request_identity"),
        (
            "/financialSnapshot/snapshotId",
            json!(""),
            "invalid_snapshot_identity",
        ),
        (
            "/financialSnapshot/contentHash",
            json!(""),
            "invalid_snapshot_identity",
        ),
        (
            "/validUntil",
            json!("2026-08-23T12:00:00Z"),
            "invalid_decision_validity",
        ),
        (
            "/validUntil",
            json!("2027-01-01T00:00:00Z"),
            "invalid_decision_validity",
        ),
        (
            "/proposedTransaction/amount/minorUnits",
            json!("0"),
            "invalid_purchase_input",
        ),
        (
            "/proposedTransaction/accountId",
            json!(""),
            "invalid_purchase_input",
        ),
        (
            "/proposedTransaction/categoryId",
            json!("other"),
            "invalid_purchase_input",
        ),
    ] {
        let mut wire = serde_json::to_value(&valid).unwrap();
        *wire.pointer_mut(pointer).unwrap() = value;
        let result = evaluate_prospective_purchase(serde_json::from_value(wire).unwrap());
        assert!(!result.payload.allowable, "{pointer}");
        assert!(
            result.issues.iter().any(
                |issue| issue.code == DecisionIssueCode::Unknown(code.into())
                    && issue.blocks_conclusion()
            ),
            "{pointer}"
        );
    }
    let mut anonymous = valid;
    anonymous.proposed_transaction.id.clear();
    anonymous.proposed_transaction.account_id.clear();
    let result = evaluate_prospective_purchase(anonymous);
    assert!(result.issues.iter().any(|issue| issue.code
        == DecisionIssueCode::Unknown("invalid_purchase_input".into())
        && issue.scope == DecisionScope::Global));
}

#[test]
fn observation_failures_block_only_their_relevant_scope_and_filter_untrusted_evidence() {
    for (kind, state, expected) in [
        (
            "account_coverage",
            "unavailable",
            DecisionIssueCode::AccountFreshnessCoverage,
        ),
        (
            "credit_card_obligation_coverage",
            "unavailable",
            DecisionIssueCode::CreditPaymentUncertainty,
        ),
        (
            "duplicate_candidate",
            "ambiguous",
            DecisionIssueCode::EconomicEventAmbiguity,
        ),
    ] {
        let mut snapshot = financial_snapshot();
        snapshot.observations = serde_json::from_value(json!([{
            "kind": kind, "state": state, "scope": {"kind": "account", "id": ACCOUNT_ID},
            "observedAt": "2026-08-23T12:00:00Z",
            "evidence": [
                {"evidenceId": "trusted", "kind": "source", "authorized": true, "redaction": "visible"},
                {"evidenceId": "hidden", "kind": "source", "authorized": true, "redaction": "redacted"},
                {"evidenceId": "unauthorized", "kind": "source", "authorized": false, "redaction": "visible"}
            ]
        }])).unwrap();
        let result = evaluate_prospective_purchase(request(
            snapshot.clone(),
            context(),
            vec![],
            proposed_purchase("USD"),
        ));
        let issue = result
            .issues
            .iter()
            .find(|issue| issue.code == expected)
            .unwrap();
        assert!(issue.blocks_conclusion());
        assert_eq!(
            issue
                .evidence
                .iter()
                .map(|reference| reference.evidence_id.as_str())
                .collect::<Vec<_>>(),
            vec!["trusted"]
        );
        assert!(result
            .evidence
            .iter()
            .all(|reference| reference.evidence_id != "hidden"
                && reference.evidence_id != "unauthorized"));
        snapshot.observations[0].scope = DecisionScope::Claim("unrelated".into());
        let unrelated = evaluate_prospective_purchase(request(
            snapshot,
            context(),
            vec![],
            proposed_purchase("USD"),
        ));
        assert!(!unrelated.issues.iter().any(|issue| issue.code == expected));
    }
}

#[test]
fn global_schedule_observations_block_and_unknown_observations_cannot_supply_evidence() {
    let mut snapshot = financial_snapshot();
    snapshot.observations = serde_json::from_value(json!([
        {"kind": "schedule_coverage", "state": "unavailable", "scope": {"kind": "global"}, "observedAt": null, "evidence": []},
        {"kind": "account_freshness", "state": "unknown", "scope": {"kind": "account", "id": ACCOUNT_ID}, "observedAt": null,
         "evidence": [{"evidenceId": "unknown-source", "kind": "source", "authorized": true, "redaction": "visible"}]}
    ])).unwrap();
    let result = evaluate_prospective_purchase(request(
        snapshot,
        context(),
        vec![],
        proposed_purchase("USD"),
    ));
    assert!(result
        .issues
        .iter()
        .any(|issue| issue.code == DecisionIssueCode::ScheduleCoverage
            && issue.scope == DecisionScope::Global
            && issue.blocks_conclusion()));
    assert!(!result
        .evidence
        .iter()
        .any(|reference| reference.evidence_id == "unknown-source"));
}

#[test]
fn configured_bank_sync_age_has_exact_boundary_and_fails_closed_for_missing_time() {
    let mut policy = context();
    policy.policy.max_bank_sync_age_minutes = Some(15);
    for (synced_at, stale) in [
        (Some("2026-08-23T11:45:00Z"), false),
        (Some("2026-08-23T11:44:59.999999999Z"), true),
        (None, true),
        (Some("invalid"), true),
    ] {
        let mut snapshot = financial_snapshot();
        snapshot.legacy_snapshot.bank_synced_at = synced_at.map(str::to_owned);
        let result = evaluate_prospective_purchase(request(
            snapshot,
            policy.clone(),
            vec![],
            proposed_purchase("USD"),
        ));
        assert_eq!(
            result
                .payload
                .reason_codes
                .iter()
                .any(|code| code == "stale_bank_sync"),
            stale
        );
        if stale {
            assert!(result.issues.iter().any(|issue| issue.code
                == DecisionIssueCode::AccountFreshnessCoverage
                && issue.scope == DecisionScope::Account(ACCOUNT_ID.into())
                && issue.blocks_conclusion()));
        }
    }
    let mut invalid_context = policy;
    invalid_context.evaluated_at = "invalid".into();
    invalid_context.policy.max_budget_snapshot_age_minutes = Some(15);
    let result = evaluate_prospective_purchase(request(
        financial_snapshot(),
        invalid_context,
        vec![],
        proposed_purchase("USD"),
    ));
    assert!(result
        .issues
        .iter()
        .any(|issue| issue.code == DecisionIssueCode::Unknown("invalid_decision_context".into())));
    assert!(!result.payload.allowable);
}

#[test]
fn category_claim_currency_and_subtraction_overflow_do_not_publish_unsafe_semantic_amounts() {
    let mut reserved = fixture_claim("fd-claim-active-reservation");
    reserved.scope = DecisionScope::Category(CATEGORY_ID.into());
    reserved.amount = Money::new(100, "EUR");
    let mismatch = evaluate_prospective_purchase(request(
        financial_snapshot(),
        context(),
        vec![reserved.clone()],
        proposed_purchase("USD"),
    ));
    assert!(mismatch
        .issues
        .iter()
        .any(|issue| issue.code == DecisionIssueCode::CurrencyMismatch));
    assert!(mismatch.before.amounts.is_empty());
    assert!(mismatch.after.amounts.is_empty());

    reserved.amount = Money::new(i64::MAX, "USD");
    let mut second = reserved.clone();
    second.claim_id = "second-huge".into();
    second.amount = Money::new(20_000, "USD");
    let overflow = evaluate_prospective_purchase(request(
        financial_snapshot(),
        context(),
        vec![reserved.clone(), second],
        proposed_purchase("USD"),
    ));
    assert!(overflow
        .issues
        .iter()
        .any(|issue| issue.code == DecisionIssueCode::Unknown("money_arithmetic_overflow".into())));
    assert!(overflow.before.amounts.is_empty());
    assert!(overflow.after.amounts.is_empty());

    let mut large_purchase = proposed_purchase("USD");
    large_purchase.amount = Money::new(-20_000, "USD");
    let after_overflow = evaluate_prospective_purchase(request(
        financial_snapshot(),
        context(),
        vec![reserved],
        large_purchase,
    ));
    assert!(after_overflow
        .issues
        .iter()
        .any(|issue| issue.code == DecisionIssueCode::Unknown("money_arithmetic_overflow".into())));
    assert!(after_overflow.after.amounts.is_empty());
}

#[test]
fn minimum_i64_purchase_fails_without_panicking_or_fabricating_after_balance() {
    let mut purchase = proposed_purchase("USD");
    purchase.amount = Money::new(i64::MIN, "USD");
    let result =
        evaluate_prospective_purchase(request(financial_snapshot(), context(), vec![], purchase));
    assert!(!result.payload.allowable);
    assert!(result
        .issues
        .iter()
        .any(|issue| issue.code == DecisionIssueCode::Unknown("purchase_evaluation_error".into())));
    assert!(result.after.amounts.is_empty());
}

#[test]
fn historical_outflow_overflow_is_reported_not_wrapped_into_purchase_capacity() {
    for amounts in [vec![i64::MIN], vec![-i64::MAX, -1]] {
        let mut snapshot = financial_snapshot();
        snapshot.legacy_snapshot.transactions = amounts
            .into_iter()
            .enumerate()
            .map(|(index, amount)| {
                let mut transaction = proposed_purchase("USD");
                transaction.id = format!("history-{index}");
                transaction.amount = Money::new(amount, "USD");
                transaction.cleared = true;
                transaction.reconciled = true;
                transaction
            })
            .collect();
        let result = evaluate_prospective_purchase(request(
            snapshot,
            context(),
            vec![],
            proposed_purchase("USD"),
        ));
        assert!(!result.payload.allowable);
        assert_eq!(result.payload.reason_codes, vec!["evaluation_error"]);
        assert!(result
            .issues
            .iter()
            .any(|issue| issue.code
                == DecisionIssueCode::Unknown("purchase_evaluation_error".into())));
        assert_eq!(result.payload.projected_balance, None);
    }
}

#[test]
fn incompatible_account_balance_does_not_appear_as_same_currency_category_capacity() {
    let mut snapshot = financial_snapshot();
    snapshot
        .legacy_snapshot
        .accounts
        .iter_mut()
        .find(|account| account.id == ACCOUNT_ID)
        .unwrap()
        .cleared_balance = Money::new(50_000, "EUR");
    let result = evaluate_prospective_purchase(request(
        snapshot,
        context(),
        vec![],
        proposed_purchase("USD"),
    ));
    assert!(result
        .issues
        .iter()
        .any(|issue| issue.code == DecisionIssueCode::CurrencyMismatch));
    assert!(result.before.amounts.is_empty());
    assert!(result.after.amounts.is_empty());
    assert_eq!(result.payload.projected_balance, None);
}
