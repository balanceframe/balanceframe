use balanceframe_core_protocol::{
    CoverageState, DecisionScope, EvidenceReference, FinancialSnapshot, InclusionScope,
    ObservationKind, ObservationState, PendingActivityTreatment, ProtocolSnapshot, RedactionState,
    SnapshotCoverage, SnapshotSource, SourceObservation, UnclearedActivityTreatment,
};
use balanceframe_financial_core::{Account, Money, Schedule, Transaction};
use serde_json::json;

const CAPTURED_AT: &str = "2026-08-23T12:34:56Z";
const FRESH_OBSERVED_AT: &str = "2026-08-23T12:30:00Z";
const STALE_OBSERVED_AT: &str = "2026-08-20T09:00:00Z";

fn legacy_snapshot() -> ProtocolSnapshot {
    ProtocolSnapshot {
        schema_version: "1.0".into(),
        actual_version: "2026.08.1".into(),
        snapshot_date: CAPTURED_AT.into(),
        accounts: vec![
            Account {
                id: "account-checking".into(),
                name: "Checking".into(),
                account_type: "checking".into(),
                off_budget: false,
                is_closed: false,
                cleared_balance: Money::new(i64::MAX, "USD"),
                imported_balance: Money::new(i64::MAX, "USD"),
                mtid: Some("source-account-checking".into()),
            },
            Account {
                id: "account-card".into(),
                name: "Credit Card".into(),
                account_type: "credit".into(),
                off_budget: false,
                is_closed: false,
                cleared_balance: Money::new(i64::MIN, "USD"),
                imported_balance: Money::new(i64::MIN, "USD"),
                mtid: Some("source-account-card".into()),
            },
        ],
        transactions: vec![Transaction {
            id: "transaction-pending".into(),
            account_id: "account-checking".into(),
            date: "2026-08-23".into(),
            payee_id: None,
            payee_name: Some("Corner Shop".into()),
            category_id: None,
            category_name: None,
            amount: Money::new(-1, "USD"),
            cleared: false,
            reconciled: false,
            imported_id: Some("import-pending".into()),
            imported_payee: Some("CORNER SHOP".into()),
            notes: None,
            tags: vec![],
            transfer_account_id: None,
            subtransactions: vec![],
        }],
        categories: vec![],
        payees: vec![],
        rules: vec![],
        schedules: vec![Schedule {
            id: "schedule-card-payment".into(),
            frequency: "monthly".into(),
            amount: Money::new(1, "USD"),
            payee_name: Some("Credit Card Payment".into()),
            account_id: "account-checking".into(),
            next_expected: "2026-08-31".into(),
        }],
        budgets: vec![],
        tags: vec![],
        actual_downloaded_at: Some("2026-08-23T12:31:00Z".into()),
        encrypted: Some(false),
        bank_synced_at: Some(FRESH_OBSERVED_AT.into()),
    }
}

fn source() -> SnapshotSource {
    SnapshotSource {
        ledger_backend: "actual".into(),
        ledger_id: "ledger-local-17".into(),
        budget_id: "budget-household".into(),
        space_id: Some("space-family".into()),
    }
}

fn coverage() -> SnapshotCoverage {
    SnapshotCoverage {
        accounts: CoverageState::Complete,
        transactions: CoverageState::Complete,
        categories: CoverageState::Empty,
        payees: CoverageState::Empty,
        rules: CoverageState::Empty,
        schedules: CoverageState::Complete,
        budgets: CoverageState::Empty,
        tags: CoverageState::Empty,
    }
}

fn inclusion_scope() -> InclusionScope {
    InclusionScope {
        pending_activity: PendingActivityTreatment::Included,
        uncleared_activity: UnclearedActivityTreatment::Included,
    }
}

fn observation(
    kind: ObservationKind,
    scope: DecisionScope,
    state: ObservationState,
    observed_at: Option<&str>,
    evidence: &[(&str, &str)],
) -> SourceObservation {
    SourceObservation {
        kind,
        scope,
        state,
        observed_at: observed_at.map(str::to_owned),
        evidence: evidence
            .iter()
            .map(|(evidence_id, kind)| EvidenceReference {
                evidence_id: (*evidence_id).to_owned(),
                kind: (*kind).to_owned(),
                authorized: true,
                redaction: RedactionState::Visible,
            })
            .collect(),
    }
}

fn financial_snapshot() -> FinancialSnapshot {
    FinancialSnapshot {
        contract_version: "1.0".into(),
        snapshot_id: "snapshot-supplied-0001".into(),
        content_hash: "sha256:content-supplied-0001".into(),
        source: source(),
        captured_at: CAPTURED_AT.into(),
        source_normalization_version: "actual-normalizer/3.2.1".into(),
        legacy_snapshot: legacy_snapshot(),
        coverage: coverage(),
        inclusion_scope: inclusion_scope(),
        observations: vec![],
    }
}

#[test]
fn canonical_snapshot_round_trip_preserves_legacy_v1_payload_and_supplied_identities() {
    let snapshot = financial_snapshot();
    let expected_legacy_wire = json!({
        "schemaVersion": "1.0",
        "actualVersion": "2026.08.1",
        "snapshotDate": CAPTURED_AT,
        "accounts": [
            {
                "id": "account-checking",
                "name": "Checking",
                "accountType": "checking",
                "offBudget": false,
                "isClosed": false,
                "clearedBalance": {
                    "minorUnits": "9223372036854775807",
                    "currency": "USD"
                },
                "importedBalance": {
                    "minorUnits": "9223372036854775807",
                    "currency": "USD"
                },
                "mtid": "source-account-checking"
            },
            {
                "id": "account-card",
                "name": "Credit Card",
                "accountType": "credit",
                "offBudget": false,
                "isClosed": false,
                "clearedBalance": {
                    "minorUnits": "-9223372036854775808",
                    "currency": "USD"
                },
                "importedBalance": {
                    "minorUnits": "-9223372036854775808",
                    "currency": "USD"
                },
                "mtid": "source-account-card"
            }
        ],
        "transactions": [{
            "id": "transaction-pending",
            "accountId": "account-checking",
            "date": "2026-08-23",
            "payeeId": null,
            "payeeName": "Corner Shop",
            "categoryId": null,
            "categoryName": null,
            "amount": { "minorUnits": "-1", "currency": "USD" },
            "cleared": false,
            "reconciled": false,
            "importedId": "import-pending",
            "importedPayee": "CORNER SHOP",
            "notes": null,
            "tags": [],
            "transferAccountId": null,
            "subtransactions": []
        }],
        "categories": [],
        "payees": [],
        "rules": [],
        "schedules": [{
            "id": "schedule-card-payment",
            "frequency": "monthly",
            "amount": { "minorUnits": "1", "currency": "USD" },
            "payeeName": "Credit Card Payment",
            "accountId": "account-checking",
            "nextExpected": "2026-08-31"
        }],
        "budgets": [],
        "tags": [],
        "actualDownloadedAt": "2026-08-23T12:31:00Z",
        "encrypted": false,
        "bankSyncedAt": FRESH_OBSERVED_AT
    });

    let legacy_wire = serde_json::to_value(&snapshot.legacy_snapshot).unwrap();
    assert_eq!(legacy_wire, expected_legacy_wire);

    let wire = serde_json::to_value(&snapshot).unwrap();
    assert_eq!(wire["snapshotId"], json!("snapshot-supplied-0001"));
    assert_eq!(wire["contentHash"], json!("sha256:content-supplied-0001"));
    assert_eq!(wire["legacySnapshot"], expected_legacy_wire);

    let decoded: FinancialSnapshot = serde_json::from_value(wire).unwrap();
    assert_eq!(decoded, snapshot);
    assert_eq!(decoded.snapshot_id, "snapshot-supplied-0001");
    assert_eq!(decoded.content_hash, "sha256:content-supplied-0001");
}

#[test]
fn source_namespace_scopes_identical_ledger_local_ids() {
    let actual = source();
    let ynab = SnapshotSource {
        ledger_backend: "ynab".into(),
        ledger_id: actual.ledger_id.clone(),
        budget_id: actual.budget_id.clone(),
        space_id: actual.space_id.clone(),
    };

    assert_ne!(actual, ynab);
    assert_eq!(
        serde_json::to_value(&actual).unwrap(),
        json!({
            "ledgerBackend": "actual",
            "ledgerId": "ledger-local-17",
            "budgetId": "budget-household",
            "spaceId": "space-family"
        })
    );
    assert_eq!(
        serde_json::to_value(&ynab).unwrap(),
        json!({
            "ledgerBackend": "ynab",
            "ledgerId": "ledger-local-17",
            "budgetId": "budget-household",
            "spaceId": "space-family"
        })
    );
}

#[test]
fn omitted_collection_coverage_is_unknown_not_explicitly_empty() {
    let mut wire = serde_json::to_value(financial_snapshot()).unwrap();
    wire["coverage"] = json!({});

    let unknown: FinancialSnapshot = serde_json::from_value(wire.clone()).unwrap();
    assert_eq!(unknown.coverage.accounts, CoverageState::Unknown);
    assert_eq!(unknown.coverage.transactions, CoverageState::Unknown);
    assert_eq!(unknown.coverage.schedules, CoverageState::Unknown);
    assert_ne!(unknown.coverage.transactions, CoverageState::Empty);

    wire["coverage"] = json!({
        "accounts": "complete",
        "transactions": "empty",
        "schedules": "empty"
    });
    let explicit: FinancialSnapshot = serde_json::from_value(wire).unwrap();
    assert_eq!(explicit.coverage.accounts, CoverageState::Complete);
    assert_eq!(explicit.coverage.transactions, CoverageState::Empty);
    assert_eq!(explicit.coverage.schedules, CoverageState::Empty);
    assert_eq!(explicit.coverage.categories, CoverageState::Unknown);
    assert_eq!(explicit.coverage.payees, CoverageState::Unknown);
    assert_eq!(explicit.coverage.rules, CoverageState::Unknown);
    assert_eq!(explicit.coverage.budgets, CoverageState::Unknown);
    assert_eq!(explicit.coverage.tags, CoverageState::Unknown);
}

#[test]
fn account_observations_retain_fresh_stale_and_unavailable_states_per_account() {
    let mut snapshot = financial_snapshot();
    snapshot.observations = vec![
        observation(
            ObservationKind::AccountFreshness,
            DecisionScope::Account("account-checking".into()),
            ObservationState::Fresh,
            Some(FRESH_OBSERVED_AT),
            &[("bank-sync:checking:884", "bank_sync")],
        ),
        observation(
            ObservationKind::AccountFreshness,
            DecisionScope::Account("account-card".into()),
            ObservationState::Stale,
            Some(STALE_OBSERVED_AT),
            &[("bank-sync:card:119", "bank_sync")],
        ),
        observation(
            ObservationKind::AccountFreshness,
            DecisionScope::Account("account-cash".into()),
            ObservationState::Unavailable,
            None,
            &[("connector-error:cash:7", "connector_error")],
        ),
    ];

    let decoded: FinancialSnapshot =
        serde_json::from_value(serde_json::to_value(&snapshot).unwrap()).unwrap();
    assert_eq!(decoded.observations, snapshot.observations);
    assert_eq!(decoded.observations[0].state, ObservationState::Fresh);
    assert_eq!(
        decoded.observations[0].observed_at.as_deref(),
        Some(FRESH_OBSERVED_AT)
    );
    assert_eq!(decoded.observations[1].state, ObservationState::Stale);
    assert_eq!(
        decoded.observations[1].observed_at.as_deref(),
        Some(STALE_OBSERVED_AT)
    );
    assert_eq!(decoded.observations[2].state, ObservationState::Unavailable);
    assert_eq!(decoded.observations[2].observed_at, None);
}

#[test]
fn inclusion_scope_and_observations_cover_pending_uncleared_schedules_and_card_obligations() {
    let mut snapshot = financial_snapshot();
    snapshot.observations = vec![
        observation(
            ObservationKind::PendingActivity,
            DecisionScope::Account("account-checking".into()),
            ObservationState::Included,
            Some(CAPTURED_AT),
            &[("transaction:transaction-pending", "transaction")],
        ),
        observation(
            ObservationKind::UnclearedActivity,
            DecisionScope::Account("account-checking".into()),
            ObservationState::Included,
            Some(CAPTURED_AT),
            &[("transaction:transaction-pending", "transaction")],
        ),
        observation(
            ObservationKind::ScheduleCoverage,
            DecisionScope::Schedule("schedule-card-payment".into()),
            ObservationState::Complete,
            Some(CAPTURED_AT),
            &[("schedule:schedule-card-payment", "schedule")],
        ),
        observation(
            ObservationKind::CreditCardObligationCoverage,
            DecisionScope::Account("account-card".into()),
            ObservationState::Complete,
            Some(CAPTURED_AT),
            &[
                ("schedule:schedule-card-payment", "schedule"),
                ("account:account-card", "account"),
            ],
        ),
    ];

    assert_eq!(
        snapshot.inclusion_scope.pending_activity,
        PendingActivityTreatment::Included
    );
    assert_eq!(
        snapshot.inclusion_scope.uncleared_activity,
        UnclearedActivityTreatment::Included
    );
    assert_eq!(snapshot.observations[0].state, ObservationState::Included);
    assert_eq!(snapshot.observations[1].state, ObservationState::Included);
    assert_eq!(snapshot.observations[2].state, ObservationState::Complete);
    assert_eq!(snapshot.observations[3].state, ObservationState::Complete);
    assert_eq!(
        snapshot.observations[3].evidence,
        vec![
            EvidenceReference {
                evidence_id: "schedule:schedule-card-payment".into(),
                kind: "schedule".into(),
                authorized: true,
                redaction: RedactionState::Visible,
            },
            EvidenceReference {
                evidence_id: "account:account-card".into(),
                kind: "account".into(),
                authorized: true,
                redaction: RedactionState::Visible,
            },
        ]
    );
}

#[test]
fn observations_retain_duplicate_transfer_reconciliation_and_currency_incompatibility() {
    let observations = vec![
        observation(
            ObservationKind::DuplicateCandidate,
            DecisionScope::Transaction("transaction-pending".into()),
            ObservationState::Present,
            Some(CAPTURED_AT),
            &[
                ("import:import-pending", "imported_transaction"),
                ("candidate:transaction-existing", "duplicate_candidate"),
            ],
        ),
        observation(
            ObservationKind::TransferAmbiguity,
            DecisionScope::Transaction("transaction-pending".into()),
            ObservationState::Ambiguous,
            Some(CAPTURED_AT),
            &[("transfer-candidate:account-card", "transfer_candidate")],
        ),
        observation(
            ObservationKind::Reconciliation,
            DecisionScope::Account("account-checking".into()),
            ObservationState::Unreconciled,
            Some(CAPTURED_AT),
            &[("transaction:transaction-pending", "transaction")],
        ),
        observation(
            ObservationKind::CurrencyCompatibility,
            DecisionScope::Account("account-card".into()),
            ObservationState::Incompatible,
            Some(CAPTURED_AT),
            &[
                ("account-currency:USD", "account_currency"),
                ("claim-currency:EUR", "claim_currency"),
            ],
        ),
    ];
    let mut snapshot = financial_snapshot();
    snapshot.observations = observations.clone();

    let decoded: FinancialSnapshot =
        serde_json::from_value(serde_json::to_value(snapshot).unwrap()).unwrap();
    assert_eq!(decoded.observations, observations);
    assert_eq!(decoded.observations[0].state, ObservationState::Present);
    assert_eq!(decoded.observations[1].state, ObservationState::Ambiguous);
    assert_eq!(
        decoded.observations[2].state,
        ObservationState::Unreconciled
    );
    assert_eq!(
        decoded.observations[3].state,
        ObservationState::Incompatible
    );
    assert_eq!(
        decoded.observations[3].evidence,
        vec![
            EvidenceReference {
                evidence_id: "account-currency:USD".into(),
                kind: "account_currency".into(),
                authorized: true,
                redaction: RedactionState::Visible,
            },
            EvidenceReference {
                evidence_id: "claim-currency:EUR".into(),
                kind: "claim_currency".into(),
                authorized: true,
                redaction: RedactionState::Visible,
            },
        ]
    );
}
