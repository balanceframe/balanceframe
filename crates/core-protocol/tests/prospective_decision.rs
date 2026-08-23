use balanceframe_core_protocol::{
    evaluate_prospective_claims, DecisionAlternative, DecisionAmount, DecisionContext,
    DecisionHorizon, DecisionIssue, DecisionIssueCode, DecisionIssueEffect, DecisionIssueSeverity,
    DecisionReadiness, DecisionScope, DecisionSemanticState, EvidenceReference, ProspectiveClaim,
    ProspectiveClaimKind, ProspectiveClaimStatus, ProspectiveDecisionEnvelope,
    ProspectiveDecisionMetadata, PurchaseEvaluation, RedactionState, Remediation,
};
use balanceframe_financial_core::{DecisionDataPolicy, FinancialStateLabel, Money};

const EVALUATED_AT: &str = "2026-08-23T12:00:00Z";
const HORIZON_END: &str = "2026-09-22T12:00:00Z";
const SNAPSHOT_ID: &str = "snapshot-2026-08-23";
const SNAPSHOT_HASH: &str = "sha256:snapshot-content";
const POLICY_VERSION: &str = "policy-17";
const POLICY_HASH: &str = "sha256:effective-policy";

fn context() -> DecisionContext {
    DecisionContext {
        evaluated_at: EVALUATED_AT.into(),
        horizon: DecisionHorizon {
            starts_at: EVALUATED_AT.into(),
            ends_at: HORIZON_END.into(),
        },
        policy: DecisionDataPolicy::default(),
        policy_version: POLICY_VERSION.into(),
        policy_hash: POLICY_HASH.into(),
        snapshot_id: SNAPSHOT_ID.into(),
        content_hash: SNAPSHOT_HASH.into(),
    }
}

fn claim(
    claim_id: &str,
    kind: ProspectiveClaimKind,
    scope: DecisionScope,
    amount: Money,
) -> ProspectiveClaim {
    ProspectiveClaim {
        claim_id: claim_id.into(),
        kind,
        source_id: format!("source-{claim_id}"),
        scope,
        amount,
        status: ProspectiveClaimStatus::Active,
        effective_from: "2026-08-01T00:00:00Z".into(),
        expires_at: Some("2026-09-01T00:00:00Z".into()),
        visibility: RedactionState::Visible,
        policy_version: POLICY_VERSION.into(),
        snapshot_id: SNAPSHOT_ID.into(),
    }
}

fn issue_codes(
    result: &balanceframe_core_protocol::ProspectiveClaimEvaluation,
) -> Vec<DecisionIssueCode> {
    result
        .issues
        .iter()
        .map(|issue| issue.code.clone())
        .collect()
}

#[test]
fn reservation_and_commitment_claims_are_immutable_round_trip_inputs() {
    let claims = vec![
        claim(
            "reservation-max",
            ProspectiveClaimKind::Reservation,
            DecisionScope::Account("account-checking".into()),
            Money::new(i64::MAX, "USD"),
        ),
        claim(
            "commitment-cent",
            ProspectiveClaimKind::Commitment,
            DecisionScope::Category("category-rent".into()),
            Money::new(1, "USD"),
        ),
    ];

    let json = serde_json::to_value(&claims).unwrap();
    assert_eq!(
        json[0]["amount"]["minorUnits"],
        i64::MAX.to_string(),
        "minor units must remain an integer string at the i64 boundary"
    );
    assert_eq!(json[0]["kind"], "reservation");
    assert_eq!(json[1]["kind"], "commitment");
    assert_eq!(json[1]["amount"]["minorUnits"], "1");

    let decoded: Vec<ProspectiveClaim> = serde_json::from_value(json).unwrap();
    assert_eq!(decoded, claims);
}

#[test]
fn eligibility_uses_only_fixed_evaluated_at_and_half_open_time_boundaries() {
    let mut active = claim(
        "active",
        ProspectiveClaimKind::Reservation,
        DecisionScope::Category("category-groceries".into()),
        Money::new(1_00, "USD"),
    );
    active.effective_from = EVALUATED_AT.into();

    let mut released = claim(
        "released",
        ProspectiveClaimKind::Reservation,
        DecisionScope::Category("category-released".into()),
        Money::new(2_00, "USD"),
    );
    released.status = ProspectiveClaimStatus::Released;

    let mut expired_at_boundary = claim(
        "expired-at-boundary",
        ProspectiveClaimKind::Commitment,
        DecisionScope::Category("category-expired".into()),
        Money::new(3_00, "USD"),
    );
    expired_at_boundary.expires_at = Some(EVALUATED_AT.into());

    let mut future = claim(
        "future",
        ProspectiveClaimKind::Commitment,
        DecisionScope::Category("category-future".into()),
        Money::new(4_00, "USD"),
    );
    future.effective_from = "2026-08-23T12:00:01Z".into();

    let mut starts_at_boundary = claim(
        "starts-at-boundary",
        ProspectiveClaimKind::Commitment,
        DecisionScope::Category("category-start".into()),
        Money::new(5_00, "USD"),
    );
    starts_at_boundary.effective_from = EVALUATED_AT.into();

    let result = evaluate_prospective_claims(
        &context(),
        &[
            active,
            released,
            expired_at_boundary,
            future,
            starts_at_boundary,
        ],
    );

    assert_eq!(
        result.eligible_claim_ids,
        vec!["active".to_string(), "starts-at-boundary".to_string()]
    );
    assert_eq!(result.reservation_total, Some(Money::new(1_00, "USD")));
    assert_eq!(result.commitment_total, Some(Money::new(5_00, "USD")));
}

#[test]
fn overlapping_scope_conflicts_but_disjoint_scope_does_not() {
    let overlapping = vec![
        claim(
            "reservation-a",
            ProspectiveClaimKind::Reservation,
            DecisionScope::Category("category-travel".into()),
            Money::new(10_00, "USD"),
        ),
        claim(
            "reservation-b",
            ProspectiveClaimKind::Reservation,
            DecisionScope::Category("category-travel".into()),
            Money::new(20_00, "USD"),
        ),
    ];
    let overlap_result = evaluate_prospective_claims(&context(), &overlapping);
    assert!(issue_codes(&overlap_result).contains(&DecisionIssueCode::ReservationConflict));
    assert!(overlap_result
        .issues
        .iter()
        .any(|issue| issue.effect == DecisionIssueEffect::Blocks
            && issue.scope == DecisionScope::Category("category-travel".into())));

    let disjoint = vec![
        overlapping[0].clone(),
        claim(
            "reservation-c",
            ProspectiveClaimKind::Reservation,
            DecisionScope::Category("category-home".into()),
            Money::new(20_00, "USD"),
        ),
    ];
    let disjoint_result = evaluate_prospective_claims(&context(), &disjoint);
    assert!(!issue_codes(&disjoint_result).contains(&DecisionIssueCode::ReservationConflict));
}

#[test]
fn duplicate_ids_and_currency_conflicts_are_reported_and_fail_closed() {
    let duplicate = claim(
        "duplicate",
        ProspectiveClaimKind::Reservation,
        DecisionScope::Account("account-checking".into()),
        Money::new(10_00, "USD"),
    );
    let duplicate_result = evaluate_prospective_claims(&context(), &[duplicate.clone(), duplicate]);
    let duplicate_issue = duplicate_result
        .issues
        .iter()
        .find(|issue| issue.code == DecisionIssueCode::Unknown("duplicate_claim_id".into()))
        .expect("duplicate claim IDs must be explicit");
    assert!(duplicate_issue.blocks_conclusion());
    assert_eq!(
        duplicate_issue.scope,
        DecisionScope::Claim("duplicate".into())
    );

    let currency_result = evaluate_prospective_claims(
        &context(),
        &[
            claim(
                "usd",
                ProspectiveClaimKind::Commitment,
                DecisionScope::Category("category-trip".into()),
                Money::new(10_00, "USD"),
            ),
            claim(
                "eur",
                ProspectiveClaimKind::Commitment,
                DecisionScope::Category("category-trip".into()),
                Money::new(10_00, "EUR"),
            ),
        ],
    );
    let currency_issue = currency_result
        .issues
        .iter()
        .find(|issue| issue.code == DecisionIssueCode::CurrencyMismatch)
        .expect("mixed currencies in an overlapping scope must be explicit");
    assert!(currency_issue.blocks_conclusion());
    assert_eq!(currency_result.commitment_total, None);
}

#[test]
fn claims_are_bound_to_the_complete_policy_and_snapshot_identity() {
    let mut wrong_policy = claim(
        "wrong-policy",
        ProspectiveClaimKind::Commitment,
        DecisionScope::Global,
        Money::new(1_00, "USD"),
    );
    wrong_policy.policy_version = "policy-16".into();

    let mut wrong_snapshot = claim(
        "wrong-snapshot",
        ProspectiveClaimKind::Reservation,
        DecisionScope::Global,
        Money::new(1_00, "USD"),
    );
    wrong_snapshot.snapshot_id = "snapshot-stale".into();

    let result = evaluate_prospective_claims(&context(), &[wrong_policy, wrong_snapshot]);
    assert!(issue_codes(&result).contains(&DecisionIssueCode::Unknown(
        "policy_version_mismatch".into()
    )));
    assert!(issue_codes(&result).contains(&DecisionIssueCode::Unknown("snapshot_mismatch".into())));
    assert!(result.issues.iter().all(|issue| issue.blocks_conclusion()));
    assert!(result.eligible_claim_ids.is_empty());
}

#[test]
fn redacted_claims_preserve_eligibility_without_disclosing_conflict_evidence() {
    let visible = claim(
        "visible",
        ProspectiveClaimKind::Reservation,
        DecisionScope::Category("category-shared".into()),
        Money::new(10_00, "USD"),
    );
    let mut redacted = claim(
        "private",
        ProspectiveClaimKind::Reservation,
        DecisionScope::Category("category-shared".into()),
        Money::new(20_00, "USD"),
    );
    redacted.visibility = RedactionState::Redacted;

    let result = evaluate_prospective_claims(&context(), &[visible, redacted]);
    assert_eq!(result.eligible_claim_ids.len(), 2);
    let issue = result
        .issues
        .iter()
        .find(|issue| issue.code == DecisionIssueCode::ReservationConflict)
        .expect("the authorized conclusion must retain the conflict");
    assert_eq!(issue.redaction, RedactionState::Redacted);
    assert!(issue.evidence.is_empty());

    let json = serde_json::to_string(issue).unwrap();
    assert!(!json.contains("source-private"));
    assert!(!json.contains("private"));
}

#[test]
fn decision_context_is_complete_round_trip_input_not_a_wall_clock_lookup() {
    let decision_context = context();
    let json = serde_json::to_value(&decision_context).unwrap();

    assert_eq!(json["evaluatedAt"], EVALUATED_AT);
    assert_eq!(json["horizon"]["startsAt"], EVALUATED_AT);
    assert_eq!(json["horizon"]["endsAt"], HORIZON_END);
    assert_eq!(json["policyVersion"], POLICY_VERSION);
    assert_eq!(json["policyHash"], POLICY_HASH);
    assert_eq!(json["snapshotId"], SNAPSHOT_ID);
    assert_eq!(json["contentHash"], SNAPSHOT_HASH);
    assert_eq!(json["policy"]["pendingMode"], "includeConservatively");
    assert_eq!(json["policy"]["uncategorizedMode"], "reserveFullAmount");
    assert_eq!(json["policy"]["unclearedMode"], "include");
    assert!(json["policy"].get("accountOverrides").is_some());
    assert!(json["policy"].get("maxBankSyncAgeMinutes").is_some());
    assert!(json["policy"].get("maxBudgetSnapshotAgeMinutes").is_some());

    let mut incomplete = json.clone();
    incomplete.as_object_mut().unwrap().remove("policy");
    assert!(
        serde_json::from_value::<DecisionContext>(incomplete).is_err(),
        "the complete effective policy cannot be omitted"
    );

    let decoded: DecisionContext = serde_json::from_value(json).unwrap();
    assert_eq!(decoded, decision_context);
}

fn purchase_payload() -> PurchaseEvaluation {
    PurchaseEvaluation {
        allowable: false,
        reason_codes: vec!["reservation_conflict".into()],
        category_budget: Money::new(50_00, "USD"),
        category_spent: Money::new(20_00, "USD"),
        category_remaining: Money::new(-5_00, "USD"),
        projected_balance: Some(Money::new(1, "USD")),
    }
}

fn semantic_state(minor_units: i64) -> DecisionSemanticState {
    DecisionSemanticState {
        amounts: vec![DecisionAmount {
            label: FinancialStateLabel::EnvelopeAvailability,
            scope: DecisionScope::Category("category-groceries".into()),
            amount: Money::new(minor_units, "USD"),
        }],
    }
}

fn purchase_envelope() -> ProspectiveDecisionEnvelope<PurchaseEvaluation> {
    ProspectiveDecisionEnvelope {
        metadata: ProspectiveDecisionMetadata {
            contract_version: "1.0".into(),
            decision_id: "decision-purchase-1".into(),
            decision_kind: "purchase".into(),
            request_id: "request-purchase-1".into(),
            correlation_id: "correlation-1".into(),
            context: context(),
        },
        readiness: DecisionReadiness::Blocked,
        before: semantic_state(25_00),
        after: semantic_state(-5_00),
        issues: vec![DecisionIssue {
            code: DecisionIssueCode::ReservationConflict,
            severity: DecisionIssueSeverity::Critical,
            effect: DecisionIssueEffect::Blocks,
            scope: DecisionScope::Category("category-groceries".into()),
            evidence: vec![],
            remediation: Some(Remediation {
                code: "release_or_reduce_reservation".into(),
                action: "Release or reduce an overlapping reservation".into(),
            }),
            redaction: RedactionState::Visible,
        }],
        evidence: vec![EvidenceReference {
            evidence_id: "evidence-budget-1".into(),
            kind: "normalized_budget".into(),
            authorized: true,
            redaction: RedactionState::Visible,
        }],
        alternatives: vec![DecisionAlternative {
            alternative_id: "alternative-wait".into(),
            summary: "Wait until the next funding date".into(),
            resulting_state: semantic_state(25_00),
        }],
        expires_at: "2026-08-23T12:15:00Z".into(),
        redaction: RedactionState::Redacted,
        payload: purchase_payload(),
    }
}

#[test]
fn prospective_decision_envelope_round_trips_all_domain_metadata_and_semantics() {
    let envelope = purchase_envelope();
    let json = serde_json::to_value(&envelope).unwrap();

    assert_eq!(json["metadata"]["contractVersion"], "1.0");
    assert_eq!(json["metadata"]["decisionId"], "decision-purchase-1");
    assert_eq!(json["metadata"]["decisionKind"], "purchase");
    assert_eq!(json["metadata"]["context"]["evaluatedAt"], EVALUATED_AT);
    assert_eq!(json["readiness"], "blocked");
    assert_eq!(json["issues"][0]["code"], "reservation_conflict");
    assert_eq!(json["before"]["amounts"][0]["amount"]["minorUnits"], "2500");
    assert_eq!(json["after"]["amounts"][0]["amount"]["minorUnits"], "-500");
    assert_eq!(json["evidence"][0]["evidenceId"], "evidence-budget-1");
    assert_eq!(json["alternatives"][0]["alternativeId"], "alternative-wait");
    assert_eq!(json["expiresAt"], "2026-08-23T12:15:00Z");
    assert_eq!(json["redaction"], "redacted");

    let decoded: ProspectiveDecisionEnvelope<PurchaseEvaluation> =
        serde_json::from_value(json).unwrap();
    assert_eq!(decoded, envelope);
    assert_eq!(decoded.payload, purchase_payload());
}

#[test]
fn prospective_decision_envelope_is_not_a_transport_envelope() {
    let json = serde_json::to_value(purchase_envelope()).unwrap();

    assert!(json.get("metadata").is_some());
    assert!(json.get("payload").is_some());
    assert!(json.get("schemaVersion").is_none());
    assert!(json.get("authorization").is_none());
    assert!(json.get("result").is_none());
    assert!(json.get("error").is_none());
}

#[test]
fn prospective_claim_evaluation_is_pure_deterministic_and_requires_no_model() {
    let claims = vec![claim(
        "deterministic",
        ProspectiveClaimKind::Commitment,
        DecisionScope::Schedule("schedule-rent".into()),
        Money::new(12_34, "USD"),
    )];
    let fixed_context = context();
    let original_claims = claims.clone();

    let first = evaluate_prospective_claims(&fixed_context, &claims);
    let second = evaluate_prospective_claims(&fixed_context, &claims);
    assert_eq!(claims, original_claims);

    assert_eq!(first, second);
    assert_eq!(first.eligible_claim_ids, vec!["deterministic".to_string()]);
    assert_eq!(first.commitment_total, Some(Money::new(12_34, "USD")));
    assert!(first.issues.is_empty());
}
