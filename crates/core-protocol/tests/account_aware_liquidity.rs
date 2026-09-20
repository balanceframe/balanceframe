use balanceframe_core_protocol::*;
use serde_json::{json, Value};
fn request() -> AccountAwareSpendabilityRequest {
    let domain: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/account-aware-liquidity.json"
    ))
    .unwrap();
    let foundation: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/financial-decision-foundation.json"
    ))
    .unwrap();
    let mut snapshot = foundation["full"].clone();
    snapshot["snapshotId"] = domain["snapshotId"].clone();
    snapshot["contentHash"] = domain["contentHash"].clone();
    snapshot["liquidity"] = domain["facts"].clone();
    // The complete domain fixture supplies Food; the foundation's empty category
    // collection no longer describes this composed snapshot.
    snapshot["coverage"]["categories"] = json!("complete");
    let mut context = foundation["claims"]["context"].clone();
    for field in ["snapshotId", "contentHash", "evaluatedAt", "horizon"] {
        context[field] = domain[field].clone();
    }
    context["policyVersion"] = domain["liquidityPolicy"]["version"].clone();
    context["policyHash"] = domain["liquidityPolicy"]["policyHash"].clone();
    serde_json::from_value(json!({"financialSnapshot":snapshot,"context":context,"liquidityPolicy":domain["liquidityPolicy"],"claimSet":domain["claimSet"],"priorAllocation":null,"scenario":domain["scenario"],"validUntil":domain["validUntil"]})).unwrap()
}
#[test]
fn canonical_boundary_binds_context_identity_and_preserves_old_snapshot_unavailability() {
    let input = request();
    let result = evaluate_account_aware_spendability(input.clone());
    assert_eq!(
        result.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    assert_eq!(
        result.purchases[0]
            .transfer_plan
            .as_ref()
            .unwrap()
            .minimum_amount
            .minor_units(),
        3000
    );
    let mut wrong = input.clone();
    wrong.context.content_hash = "wrong".into();
    assert_eq!(
        evaluate_account_aware_spendability(wrong).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    let mut legacy = serde_json::to_value(input).unwrap();
    legacy["financialSnapshot"]
        .as_object_mut()
        .unwrap()
        .remove("liquidity");
    let old: AccountAwareSpendabilityRequest = serde_json::from_value(legacy).unwrap();
    assert_eq!(
        evaluate_account_aware_spendability(old).payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}
#[test]
fn canonical_preconditions_revalidate_fresh_capture_without_mutating_plan() {
    let mut input = request();
    let plan = evaluate_account_aware_spendability(input.clone())
        .purchases
        .remove(0)
        .transfer_plan
        .unwrap();
    let original = plan.clone();
    input.financial_snapshot.snapshot_id = "new".into();
    input.financial_snapshot.content_hash = "new-content".into();
    input.context.snapshot_id = "new".into();
    input.context.content_hash = "new-content".into();
    assert!(
        verify_transfer_preconditions(VerifyTransferPreconditionsRequest {
            plan: plan.clone(),
            current_input: input,
            own_claim_id: None
        })
        .valid
    );
    assert_eq!(plan, original);
}

fn prospective_request() -> ProspectivePurchaseEvaluationRequest {
    let request = request();
    let foundation: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/financial-decision-foundation.json"
    ))
    .unwrap();
    let mut transaction: balanceframe_financial_core::Transaction =
        serde_json::from_value(foundation["full"]["legacySnapshot"]["transactions"][0].clone())
            .unwrap();
    transaction.id = "prospective".into();
    transaction.account_id = "checking".into();
    transaction.category_id = Some("food".into());
    transaction.amount = balanceframe_financial_core::Money::new(-2000, "USD");
    transaction.date = "2026-09-06".into();
    ProspectivePurchaseEvaluationRequest {
        financial_snapshot: request.financial_snapshot,
        context: request.context,
        claims: vec![],
        proposed_transaction: transaction,
        category_id: "food".into(),
        request_id: "purchase-1".into(),
        correlation_id: "correlation".into(),
        decision_id: "decision".into(),
        valid_until: request.valid_until,
        redaction: RedactionState::Visible,
        liquidity: Some(PurchaseLiquidityContext {
            liquidity_policy: request.liquidity_policy,
            claim_set: request.claim_set,
            prior_allocation: request.prior_allocation,
            route_selection: RouteSelection {
                explicit_account_id: Some("checking".into()),
                session_account_id: None,
                approved_preference: None,
                historical_route: None,
            },
            purchase_at: "2026-09-06T12:00:00Z".into(),
            required_by: "2026-09-06T12:00:00Z".into(),
        }),
    }
}

#[test]
fn legacy_claims_are_not_silently_lost_by_additive_liquidity_context() {
    let mut request = prospective_request();
    request.claims.push(ProspectiveClaim {
        claim_id: "legacy-claim".into(),
        kind: ProspectiveClaimKind::Reservation,
        source_id: "economic-claim".into(),
        scope: DecisionScope::Category("food".into()),
        amount: balanceframe_financial_core::Money::new(1000, "USD"),
        status: ProspectiveClaimStatus::Active,
        effective_from: request.context.evaluated_at.clone(),
        expires_at: Some(request.valid_until.clone()),
        visibility: RedactionState::Visible,
        policy_version: request.context.policy_version.clone(),
        snapshot_id: request.context.snapshot_id.clone(),
    });
    let result = evaluate_prospective_purchase(request.clone())
        .payload
        .account_aware
        .unwrap();
    assert_eq!(result.budget_funding_status, BudgetFundingStatus::Unfunded);
    request.claims[0].scope = DecisionScope::Account("savings".into());
    request.claims[0].amount = balanceframe_financial_core::Money::new(19000, "USD");
    let result = evaluate_prospective_purchase(request)
        .payload
        .account_aware
        .unwrap();
    assert_ne!(
        result.payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
}

#[test]
fn duplicate_legacy_and_liquidity_claim_id_is_attributed_once() {
    let mut request = prospective_request();
    request.proposed_transaction.amount = balanceframe_financial_core::Money::new(-1000, "USD");
    let amount = balanceframe_financial_core::Money::new(1000, "USD");
    request.claims.push(ProspectiveClaim {
        claim_id: "same".into(),
        kind: ProspectiveClaimKind::Reservation,
        source_id: "economic".into(),
        scope: DecisionScope::Category("food".into()),
        amount: amount.clone(),
        status: ProspectiveClaimStatus::Active,
        effective_from: request.context.evaluated_at.clone(),
        expires_at: Some(request.valid_until.clone()),
        visibility: RedactionState::Visible,
        policy_version: request.context.policy_version.clone(),
        snapshot_id: request.context.snapshot_id.clone(),
    });
    request
        .liquidity
        .as_mut()
        .unwrap()
        .claim_set
        .bundles
        .push(LiquidityClaimBundle {
            id: "same".into(),
            creation_snapshot_id: request.context.snapshot_id.clone(),
            creation_policy_version: request.context.policy_version.clone(),
            state: LiquidityClaimState::Active,
            expires_at: request.valid_until.clone(),
            initiated: false,
            effects: vec![LiquidityClaimEffect {
                kind: ClaimEffectKind::Category,
                resource_id: "food".into(),
                amount,
                economic_obligation_id: "economic".into(),
                category_id: None,
                included_in_balance: false,
                matched_transaction_ids: vec![],
            }],
        });
    assert_eq!(
        evaluate_prospective_purchase(request)
            .payload
            .account_aware
            .unwrap()
            .budget_funding_status,
        BudgetFundingStatus::Funded
    );
}

#[test]
fn canonical_allowable_uses_authoritative_availability_not_legacy_budget_assignment() {
    let mut request = prospective_request();
    request.context.policy.max_budget_snapshot_age_minutes = None;
    request.context.policy.max_bank_sync_age_minutes = None;
    request.financial_snapshot.captured_at = request.context.evaluated_at.clone();
    request.financial_snapshot.observations.clear();
    let legacy = &mut request.financial_snapshot.legacy_snapshot;
    legacy.snapshot_date = request.context.evaluated_at.clone();
    legacy.bank_synced_at = Some(request.context.evaluated_at.clone());
    legacy.transactions.clear();
    let mut account = legacy.accounts[0].clone();
    account.id = "checking".into();
    account.cleared_balance = balanceframe_financial_core::Money::new(13000, "USD");
    account.imported_balance = account.cleared_balance.clone();
    legacy.accounts = vec![account];
    legacy.categories = vec![balanceframe_financial_core::Category {
        id: "food".into(),
        name: "Food".into(),
        group_name: None,
        is_income: false,
        mtid: None,
        deleted: false,
    }];
    legacy.budgets = vec![balanceframe_financial_core::BudgetMonth {
        id: "month".into(),
        month: "2026-09".into(),
        categories: std::collections::HashMap::from([(
            "food".into(),
            balanceframe_financial_core::BudgetCategory {
                category_id: "food".into(),
                amount: balanceframe_financial_core::Money::new(1000, "USD"),
                carryover: balanceframe_financial_core::Money::new(0, "USD"),
                carryover_from_previous: balanceframe_financial_core::Money::new(0, "USD"),
                carries_over: false,
            },
        )]),
    }];
    request.financial_snapshot.coverage.budgets = CoverageState::Complete;
    request
        .financial_snapshot
        .liquidity
        .as_mut()
        .unwrap()
        .accounts[0]
        .recorded_balance = balanceframe_financial_core::Money::new(13000, "USD");
    let result = evaluate_prospective_purchase(request);
    assert_eq!(
        result
            .payload
            .account_aware
            .as_ref()
            .unwrap()
            .budget_funding_status,
        BudgetFundingStatus::Funded
    );
    assert_eq!(
        result
            .payload
            .account_aware
            .as_ref()
            .unwrap()
            .payment_liquidity_status,
        PaymentLiquidityStatus::Ready
    );
    assert!(result.payload.allowable);
}

#[test]
fn review_incomplete_source_coverage_preserves_funding_but_not_cash_readiness() {
    for field in ["accounts", "categories", "budgets"] {
        let mut wire = serde_json::to_value(request()).unwrap();
        wire["financialSnapshot"]["coverage"][field] = json!("unknown");
        let result = evaluate_account_aware_spendability(serde_json::from_value(wire).unwrap());
        assert_eq!(result.budget_funding_status, BudgetFundingStatus::Funded);
        assert_eq!(
            result.payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData
        );
        assert!(!result.backing_before.feasible && !result.backing_after.feasible);
        assert!(result.accounts_after.iter().all(|account| account
            .safe_spending_capacity
            .is_none()
            && account.safe_transfer_capacity.is_none()
            && account.backing_capacity.is_none()));
        assert!(result
            .purchases
            .iter()
            .all(|purchase| purchase.transfer_plan.is_none()));
    }
}

#[test]
fn review_partial_account_metadata_needs_explicit_complete_enumeration() {
    let mut wire = serde_json::to_value(request()).unwrap();
    wire["financialSnapshot"]["coverage"]["accounts"] = json!("partial");
    assert_eq!(
        evaluate_account_aware_spendability(serde_json::from_value(wire.clone()).unwrap())
            .payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    let receipt = json!({"kind":"account_collection_coverage","scope":{"kind":"global"},"state":"complete","observedAt":"2026-09-06T09:00:00Z","evidence":[]});
    wire["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(receipt.clone());
    assert_eq!(
        evaluate_account_aware_spendability(serde_json::from_value(wire.clone()).unwrap())
            .payment_liquidity_status,
        PaymentLiquidityStatus::TransferRequired
    );
    let mut wrong_scope = wire.clone();
    wrong_scope["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .last_mut()
        .unwrap()["scope"] = json!({"kind":"account","id":"checking"});
    assert_eq!(
        evaluate_account_aware_spendability(serde_json::from_value(wrong_scope).unwrap())
            .payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    for state in ["unknown", "unavailable"] {
        let mut unknown = wire.clone();
        unknown["financialSnapshot"]["observations"]
            .as_array_mut()
            .unwrap()
            .last_mut()
            .unwrap()["state"] = json!(state);
        assert_eq!(
            evaluate_account_aware_spendability(serde_json::from_value(unknown).unwrap())
                .payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData
        );
    }
    let mut conflicting = wire.clone();
    let mut disagreement = receipt;
    disagreement["state"] = json!("unknown");
    conflicting["financialSnapshot"]["observations"]
        .as_array_mut()
        .unwrap()
        .push(disagreement);
    assert_eq!(
        evaluate_account_aware_spendability(serde_json::from_value(conflicting).unwrap())
            .payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    let mut failed_collection = wire.clone();
    failed_collection["financialSnapshot"]["coverage"]["accounts"] = json!("unknown");
    assert_eq!(
        evaluate_account_aware_spendability(serde_json::from_value(failed_collection).unwrap())
            .payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
    wire["financialSnapshot"]["liquidity"]["accounts"][0]["kindEvidence"]["state"] =
        json!("unknown");
    assert_eq!(
        evaluate_account_aware_spendability(serde_json::from_value(wire).unwrap())
            .payment_liquidity_status,
        PaymentLiquidityStatus::InsufficientData
    );
}

#[test]
fn empty_collection_receipts_cannot_hide_present_normalized_liquidity_facts() {
    for collection in ["accounts", "categories"] {
        let mut wire = serde_json::to_value(request()).unwrap();
        wire["financialSnapshot"]["legacySnapshot"][collection] = json!([]);
        wire["financialSnapshot"]["coverage"][collection] = json!("empty");
        let result = evaluate_account_aware_spendability(serde_json::from_value(wire).unwrap());
        assert_eq!(
            result.payment_liquidity_status,
            PaymentLiquidityStatus::InsufficientData
        );
        assert!(result
            .purchases
            .iter()
            .all(|purchase| purchase.transfer_plan.is_none()));
    }
}

#[test]
fn preconditions_fail_closed_when_current_context_is_not_bound_to_snapshot_or_policy() {
    let input = request();
    let plan = evaluate_account_aware_spendability(input.clone())
        .purchases
        .remove(0)
        .transfer_plan
        .unwrap();
    for (field, reason) in [
        ("snapshotId", "snapshot_identity_mismatch"),
        ("policyHash", "policy_identity_mismatch"),
    ] {
        let mut wire = serde_json::to_value(&input).unwrap();
        wire["context"][field] = json!("wrong");
        let wrong: AccountAwareSpendabilityRequest = serde_json::from_value(wire).unwrap();
        assert_eq!(
            evaluate_account_aware_spendability(wrong.clone()).reasons,
            vec![reason]
        );
        let result = verify_transfer_preconditions(VerifyTransferPreconditionsRequest {
            plan: plan.clone(),
            current_input: wrong,
            own_claim_id: None,
        });
        assert!(!result.valid);
        assert_eq!(result.reasons, vec![reason]);
    }
}
