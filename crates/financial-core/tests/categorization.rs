use balanceframe_financial_core::{
    CandidateStatus, CategorizationCandidate, Evidence, EvidenceKind, InferencePolicy, Money,
    Provenance,
};

fn sample_candidate(
    tx_id: &str,
    reasons: Vec<Evidence>,
) -> CategorizationCandidate {
    CategorizationCandidate {
        transaction_id: tx_id.into(),
        amount: Money::new(100, "USD"),
        payee_name: Some("Test Store".into()),
        date: "2026-07-18".into(),
        reasons,
    }
}

// ---------------------------------------------------------------------------
// Unresolved-candidate eligibility
// ---------------------------------------------------------------------------

#[test]
fn test_candidate_with_exact_payee_is_resolved() {
    let candidate = sample_candidate("tx1", vec![Evidence::new(
        EvidenceKind::ExactPayee,
        "Payee 'Known Store' (id=p1)",
    )]);
    assert_eq!(candidate.eligibility(), CandidateStatus::Resolved);
}

#[test]
fn test_candidate_with_historical_is_resolved() {
    let candidate = sample_candidate("tx2", vec![Evidence::new(
        EvidenceKind::Historical,
        "Previously categorized as 'Food' (id=c1) on 2026-07-01",
    )]);
    assert_eq!(candidate.eligibility(), CandidateStatus::Resolved);
}

#[test]
fn test_candidate_with_amount_pattern_is_unresolved() {
    let candidate = sample_candidate("tx3", vec![Evidence::new(
        EvidenceKind::AmountPattern,
        "Matches recurring charge of $9.99",
    )]);
    assert_eq!(candidate.eligibility(), CandidateStatus::Unresolved);
}

#[test]
fn test_candidate_with_import_match_is_unresolved() {
    let candidate = sample_candidate("tx4", vec![Evidence::new(
        EvidenceKind::ImportMatch,
        "Matched by imported ID imp001",
    )]);
    assert_eq!(candidate.eligibility(), CandidateStatus::Unresolved);
}

#[test]
fn test_candidate_with_no_evidence_is_unresolved() {
    let candidate = sample_candidate("tx5", vec![]);
    assert_eq!(candidate.eligibility(), CandidateStatus::Unresolved);
}

#[test]
fn test_eligibility_uses_strongest_evidence() {
    // Even with multiple evidence items, the first/strongest determines eligibility
    let candidate = sample_candidate("tx6", vec![
        Evidence::new(EvidenceKind::ExactPayee, "Payee 'Store' (id=p1)"),
        Evidence::new(EvidenceKind::AmountPattern, "Matches pattern"),
    ]);
    assert_eq!(candidate.eligibility(), CandidateStatus::Resolved);
}

// ---------------------------------------------------------------------------
// InferencePolicy serialization
// ---------------------------------------------------------------------------

#[test]
fn test_inference_policy_camel_case_serde() {
    let json = serde_json::to_string(&InferencePolicy::Disabled).unwrap();
    assert_eq!(json, "\"disabled\"", "Disabled must serialize as 'disabled'");

    let json = serde_json::to_string(&InferencePolicy::LocalOnly).unwrap();
    assert_eq!(json, "\"localOnly\"", "LocalOnly must serialize as 'localOnly'");

    let json = serde_json::to_string(&InferencePolicy::ExternalAllowed).unwrap();
    assert_eq!(json, "\"externalAllowed\"", "ExternalAllowed must serialize as 'externalAllowed'");

    let back: InferencePolicy = serde_json::from_str("\"disabled\"").unwrap();
    assert_eq!(back, InferencePolicy::Disabled);
}

// ---------------------------------------------------------------------------
// Provenance round-trip
// ---------------------------------------------------------------------------

#[test]
fn test_provenance_round_trip() {
    let provenance = Provenance {
        payload_hash: "abc123".into(),
        provider: Some("openai".into()),
        model: Some("gpt-4".into()),
        prompt_version: Some("v2".into()),
        inference_policy_version: Some("1.0".into()),
        created_at: "2026-07-18T12:00:00Z".into(),
        actor_id: Some("user-1".into()),
    };

    let json = serde_json::to_string(&provenance).unwrap();
    let back: Provenance = serde_json::from_str(&json).unwrap();
    assert_eq!(provenance, back);
    // Verify camelCase field naming
    assert!(json.contains("payloadHash"), "payloadHash must be camelCase");
    assert!(json.contains("inferencePolicyVersion"), "inferencePolicyVersion must be camelCase");
}

#[test]
fn test_provenance_default_fields() {
    let provenance = Provenance {
        payload_hash: "def456".into(),
        provider: None,
        model: None,
        prompt_version: None,
        inference_policy_version: None,
        created_at: "2026-07-18T12:00:00Z".into(),
        actor_id: None,
    };

    let json = serde_json::to_string(&provenance).unwrap();
    assert!(json.contains("\"provider\":null"));
    assert!(json.contains("\"model\":null"));
}
