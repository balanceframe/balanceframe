use balanceframe_financial_core::{
    DecisionIssue, DecisionIssueCode, DecisionIssueEffect, DecisionIssueSeverity, DecisionScope,
    EvidenceReference, FinancialStateLabel, RedactionState, Remediation,
};
use serde_json::json;

#[test]
fn financial_state_label_additions_use_exact_camel_case_wire_values() {
    let cases = [
        (FinancialStateLabel::AccountLiquidity, "accountLiquidity"),
        (FinancialStateLabel::Reservation, "reservation"),
        (FinancialStateLabel::Commitment, "commitment"),
        (FinancialStateLabel::SourceObservation, "sourceObservation"),
        (
            FinancialStateLabel::NormalizedEvidence,
            "normalizedEvidence",
        ),
        (
            FinancialStateLabel::EconomicEventResolution,
            "economicEventResolution",
        ),
        (
            FinancialStateLabel::RedactedConclusion,
            "redactedConclusion",
        ),
    ];

    for (label, wire_value) in cases {
        let json = serde_json::to_string(&label).unwrap();
        assert_eq!(json, format!(r#""{wire_value}""#));
        assert_eq!(
            serde_json::from_str::<FinancialStateLabel>(&json).unwrap(),
            label
        );
    }
}

#[test]
fn known_decision_issue_codes_use_exact_snake_case_wire_values() {
    let cases = [
        (
            DecisionIssueCode::AccountFreshnessCoverage,
            "account_freshness_coverage",
        ),
        (
            DecisionIssueCode::PendingAvailability,
            "pending_availability",
        ),
        (DecisionIssueCode::ScheduleCoverage, "schedule_coverage"),
        (
            DecisionIssueCode::DuplicateTransferAmbiguity,
            "duplicate_transfer_ambiguity",
        ),
        (
            DecisionIssueCode::CreditPaymentUncertainty,
            "credit_payment_uncertainty",
        ),
        (
            DecisionIssueCode::ReservationConflict,
            "reservation_conflict",
        ),
        (
            DecisionIssueCode::WalletBalanceUncertainty,
            "wallet_balance_uncertainty",
        ),
        (
            DecisionIssueCode::ReceiptTotalMismatch,
            "receipt_total_mismatch",
        ),
        (
            DecisionIssueCode::EconomicEventAmbiguity,
            "economic_event_ambiguity",
        ),
        (DecisionIssueCode::CurrencyMismatch, "currency_mismatch"),
    ];

    for (code, wire_value) in cases {
        let json = serde_json::to_string(&code).unwrap();
        assert_eq!(json, format!(r#""{wire_value}""#));
        assert_eq!(
            serde_json::from_str::<DecisionIssueCode>(&json).unwrap(),
            code
        );
    }
}

#[test]
fn unknown_decision_issue_code_round_trips_losslessly() {
    let wire = r#""provider_balance_authentication_uncertain""#;
    let code: DecisionIssueCode = serde_json::from_str(wire).unwrap();

    assert_eq!(
        code,
        DecisionIssueCode::Unknown("provider_balance_authentication_uncertain".into())
    );
    assert_eq!(serde_json::to_string(&code).unwrap(), wire);
}

#[test]
fn decision_scope_variants_have_exact_typed_wire_shapes() {
    let cases = [
        (DecisionScope::Global, json!({ "kind": "global" })),
        (
            DecisionScope::Account("account_123".into()),
            json!({ "kind": "account", "id": "account_123" }),
        ),
        (
            DecisionScope::Category("category_123".into()),
            json!({ "kind": "category", "id": "category_123" }),
        ),
        (
            DecisionScope::Transaction("transaction_123".into()),
            json!({ "kind": "transaction", "id": "transaction_123" }),
        ),
        (
            DecisionScope::Schedule("schedule_123".into()),
            json!({ "kind": "schedule", "id": "schedule_123" }),
        ),
        (
            DecisionScope::Claim("claim_123".into()),
            json!({ "kind": "claim", "id": "claim_123" }),
        ),
    ];

    for (scope, wire_value) in cases {
        assert_eq!(serde_json::to_value(&scope).unwrap(), wire_value);
        assert_eq!(
            serde_json::from_value::<DecisionScope>(wire_value).unwrap(),
            scope
        );
    }
}

#[test]
fn decision_issue_axes_use_exact_wire_strings() {
    let severities = [
        (DecisionIssueSeverity::Info, "info"),
        (DecisionIssueSeverity::Warning, "warning"),
        (DecisionIssueSeverity::Critical, "critical"),
    ];
    for (severity, wire_value) in severities {
        let json = serde_json::to_string(&severity).unwrap();
        assert_eq!(json, format!(r#""{wire_value}""#));
        assert_eq!(
            serde_json::from_str::<DecisionIssueSeverity>(&json).unwrap(),
            severity
        );
    }

    let effects = [
        (DecisionIssueEffect::Qualifies, "qualifies"),
        (DecisionIssueEffect::Blocks, "blocks"),
    ];
    for (effect, wire_value) in effects {
        let json = serde_json::to_string(&effect).unwrap();
        assert_eq!(json, format!(r#""{wire_value}""#));
        assert_eq!(
            serde_json::from_str::<DecisionIssueEffect>(&json).unwrap(),
            effect
        );
    }

    let redaction_states = [
        (RedactionState::Visible, "visible"),
        (RedactionState::Redacted, "redacted"),
    ];
    for (redaction, wire_value) in redaction_states {
        let json = serde_json::to_string(&redaction).unwrap();
        assert_eq!(json, format!(r#""{wire_value}""#));
        assert_eq!(
            serde_json::from_str::<RedactionState>(&json).unwrap(),
            redaction
        );
    }
}

#[test]
fn decision_issue_serializes_complete_authorized_metadata_and_round_trips() {
    let issue = DecisionIssue {
        code: DecisionIssueCode::ReceiptTotalMismatch,
        severity: DecisionIssueSeverity::Critical,
        effect: DecisionIssueEffect::Blocks,
        scope: DecisionScope::Transaction("transaction_123".into()),
        evidence: vec![EvidenceReference {
            evidence_id: "evidence_123".into(),
            kind: "receipt_total".into(),
            authorized: false,
            redaction: RedactionState::Redacted,
        }],
        remediation: Some(Remediation {
            code: "review_receipt_total".into(),
            action: "Review the receipt total and linked transaction.".into(),
        }),
        redaction: RedactionState::Redacted,
    };

    let wire_value = json!({
        "code": "receipt_total_mismatch",
        "severity": "critical",
        "effect": "blocks",
        "scope": {
            "kind": "transaction",
            "id": "transaction_123"
        },
        "evidence": [{
            "evidenceId": "evidence_123",
            "kind": "receipt_total",
            "authorized": false,
            "redaction": "redacted"
        }],
        "remediation": {
            "code": "review_receipt_total",
            "action": "Review the receipt total and linked transaction."
        },
        "redaction": "redacted"
    });

    assert_eq!(serde_json::to_value(&issue).unwrap(), wire_value);
    assert_eq!(
        serde_json::from_value::<DecisionIssue>(wire_value).unwrap(),
        issue
    );
}

#[test]
fn decision_issue_omits_absent_remediation_and_round_trips() {
    let issue = DecisionIssue {
        code: DecisionIssueCode::PendingAvailability,
        severity: DecisionIssueSeverity::Warning,
        effect: DecisionIssueEffect::Qualifies,
        scope: DecisionScope::Account("account_123".into()),
        evidence: Vec::new(),
        remediation: None,
        redaction: RedactionState::Visible,
    };

    let wire_value = serde_json::to_value(&issue).unwrap();
    assert_eq!(wire_value.get("remediation"), None);
    assert_eq!(
        serde_json::from_value::<DecisionIssue>(wire_value).unwrap(),
        issue
    );
}

#[test]
fn unknown_safety_sensitive_issue_fails_closed() {
    let issue = DecisionIssue {
        code: DecisionIssueCode::Unknown("provider_balance_authentication_uncertain".into()),
        severity: DecisionIssueSeverity::Critical,
        effect: DecisionIssueEffect::Qualifies,
        scope: DecisionScope::Account("account_123".into()),
        evidence: vec![EvidenceReference {
            evidence_id: "provider_observation_123".into(),
            kind: "provider_balance_observation".into(),
            authorized: true,
            redaction: RedactionState::Visible,
        }],
        remediation: None,
        redaction: RedactionState::Visible,
    };

    assert!(issue.blocks_conclusion());

    let json = serde_json::to_string(&issue).unwrap();
    let round_tripped: DecisionIssue = serde_json::from_str(&json).unwrap();
    assert_eq!(round_tripped, issue);
    assert!(round_tripped.blocks_conclusion());
}

#[test]
fn known_issue_effect_controls_blocking_semantics() {
    let qualified = DecisionIssue {
        code: DecisionIssueCode::PendingAvailability,
        severity: DecisionIssueSeverity::Warning,
        effect: DecisionIssueEffect::Qualifies,
        scope: DecisionScope::Global,
        evidence: Vec::new(),
        remediation: None,
        redaction: RedactionState::Visible,
    };
    assert!(!qualified.blocks_conclusion());

    let blocked = DecisionIssue {
        effect: DecisionIssueEffect::Blocks,
        ..qualified
    };
    assert!(blocked.blocks_conclusion());
}
