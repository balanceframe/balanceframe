use balanceframe_core_protocol::resolve_transaction_evidence;
use serde_json::{json, Value};
fn fixture() -> Value {
    serde_json::from_str(include_str!(
        "../../../protocol/fixtures/wallet-statement.json"
    ))
    .unwrap()
}
#[test]
fn human_statement_requires_exact_manifest_before_emitting_balance_anchors() {
    let mut input = fixture();
    input["statementProofs"][0]["activityManifest"] = json!([]);
    let parsed = serde_json::from_value(input).unwrap();
    let output = serde_json::to_value(resolve_transaction_evidence(&parsed).unwrap()).unwrap();
    assert_eq!(
        output["wallets"][0]["coverage"]["intervals"][0]["state"],
        json!("invalid")
    );
    assert_eq!(output["wallets"][0]["balanceAnchors"], json!([]));
}
fn preview(input: &Value) -> Value {
    serde_json::to_value(balanceframe_core_protocol::derive_wallet_statement_preview(&serde_json::from_value(json!({"contractVersion":"1","evidence":input,"walletId":"wallet","startDate":"2026-10-15","endDate":"2026-10-16"})).unwrap()).unwrap()).unwrap()
}
fn attest(mut input: Value) -> Value {
    let p = preview(&input);
    input["statementProofs"][0]["activityManifest"] = p["activityManifest"].clone();
    input
}
fn resolve(input: Value) -> Value {
    serde_json::to_value(
        resolve_transaction_evidence(&serde_json::from_value(input).unwrap()).unwrap(),
    )
    .unwrap()
}
#[test]
fn valid_exact_statement_derives_both_boundaries_and_claim_proofs() {
    let input = attest(fixture());
    let output = resolve(input);
    let w = &output["wallets"][0];
    assert_eq!(w["balanceState"], "known");
    assert_eq!(w["balanceAnchors"][0]["amount"]["minorUnits"], "200");
    assert_eq!(w["balanceAnchors"][1]["amount"]["minorUnits"], "100");
    assert_eq!(
        w["anchorObservations"][0]["scope"],
        json!({"kind":"claim","id":"wallet"})
    );
    assert_eq!(
        w["anchorObservations"][0]["walletBalanceAnchor"],
        w["balanceAnchors"][0]
    );
    assert!(w["coverage"]["blockedObservationIds"]
        .as_array()
        .unwrap()
        .is_empty());
}
#[test]
fn either_boundary_infers_other_and_empty_statement_is_supported() {
    let mut input = attest(fixture());
    input["statementProofs"][0]["openingBalance"] = Value::Null;
    assert_eq!(
        resolve(input)["wallets"][0]["balanceAnchors"][0]["amount"]["minorUnits"],
        "200"
    );
    let mut input = fixture();
    input["observations"] = json!([]);
    input["statementProofs"][0]["activityManifest"] = json!([]);
    input["statementProofs"][0]["closingBalance"] = Value::Null;
    assert_eq!(
        resolve(input)["wallets"][0]["closingBalance"]["minorUnits"],
        "200"
    );
}
#[test]
fn same_day_unknown_order_preserves_closing_anchor_but_blocks_outflow_only() {
    let mut input = fixture();
    let mut incoming = input["observations"][0].clone();
    incoming["id"] = json!("inflow");
    incoming["externalEventId"] = json!("inflow");
    incoming["kind"] = json!("wallet_refund");
    incoming["direction"] = json!("inflow");
    input["observations"].as_array_mut().unwrap().push(incoming);
    input["statementProofs"][0]["openingBalance"]["minorUnits"] = json!("0");
    input["statementProofs"][0]["closingBalance"]["minorUnits"] = json!("0");
    let output = resolve(attest(input));
    let w = &output["wallets"][0];
    assert_eq!(w["balanceState"], "balance_unknown");
    assert_eq!(w["balanceAnchors"].as_array().unwrap().len(), 2);
    assert_eq!(w["coverage"]["blockedObservationIds"], json!(["wallet-1"]));
    assert_eq!(
        output["blockers"]
            .as_array()
            .unwrap()
            .iter()
            .find(|b| b["code"] == "wallet_statement_order_unknown")
            .unwrap()["subjectId"],
        "wallet-1"
    );
}
#[test]
fn chronological_negative_day_invalidates_statement_even_when_final_balances_match() {
    let mut input = fixture();
    let mut incoming = input["observations"][0].clone();
    incoming["id"] = json!("later");
    incoming["externalEventId"] = json!("later");
    incoming["kind"] = json!("wallet_refund");
    incoming["direction"] = json!("inflow");
    incoming["date"] = json!("2026-10-16");
    input["observations"].as_array_mut().unwrap().push(incoming);
    input["statementProofs"][0]["openingBalance"]["minorUnits"] = json!("0");
    input["statementProofs"][0]["closingBalance"]["minorUnits"] = json!("0");
    let output = resolve(attest(input));
    assert_eq!(output["wallets"][0]["balanceAnchors"], json!([]));
    assert_eq!(
        output["wallets"][0]["coverage"]["intervals"][0]["reasonCodes"],
        json!(["statement_balance_discontinuity"])
    );
}
#[test]
fn changed_source_amount_policy_and_missing_manifest_invalidate_coverage() {
    for path in ["content", "parser", "amount", "policy", "manifest"] {
        let mut input = attest(fixture());
        match path {
            "content" => {
                input["observations"][0]["provenance"]["contentHash"] = json!("d".repeat(64))
            }
            "parser" => input["observations"][0]["provenance"]["parserVersion"] = json!("new"),
            "amount" => input["observations"][0]["amount"]["minorUnits"] = json!("99"),
            "policy" => input["policyVersion"] = json!("changed"),
            _ => input["statementProofs"][0]["activityManifest"] = json!([]),
        };
        assert_eq!(
            resolve(input)["wallets"][0]["balanceAnchors"],
            json!([]),
            "{path}"
        );
    }
}
#[test]
fn unrelated_activity_outside_interval_does_not_change_anchor_hash() {
    let input = attest(fixture());
    let before = resolve(input.clone());
    let mut after = input;
    let mut extra = after["observations"][0].clone();
    extra["id"] = json!("outside");
    extra["externalEventId"] = json!("outside");
    extra["date"] = json!("2026-10-20");
    after["observations"].as_array_mut().unwrap().push(extra);
    let after = resolve(after);
    assert_eq!(
        before["wallets"][0]["balanceAnchors"],
        after["wallets"][0]["balanceAnchors"]
    );
    assert_eq!(
        after["wallets"][0]["coverage"]["uncoveredObservationIds"],
        json!(["outside"])
    );
}
#[test]
fn overlapping_conflicts_are_scoped_and_compatible_adjacent_statements_join() {
    let mut input = attest(fixture());
    let mut other = input["statementProofs"][0].clone();
    other["proofId"] = json!("other");
    other["openingBalance"]["minorUnits"] = json!("201");
    other["closingBalance"]["minorUnits"] = json!("101");
    input["statementProofs"].as_array_mut().unwrap().push(other);
    assert_eq!(resolve(input)["wallets"][0]["balanceAnchors"], json!([]));
    let mut input = attest(fixture());
    let mut other = input["statementProofs"][0].clone();
    other["proofId"] = json!("next");
    other["startDate"] = json!("2026-10-17");
    other["endDate"] = json!("2026-10-18");
    other["openingBalance"]["minorUnits"] = json!("100");
    other["closingBalance"]["minorUnits"] = json!("100");
    other["activityManifest"] = json!([]);
    input["statementProofs"]
        .as_array_mut()
        .unwrap()
        .push(other.clone());
    assert_eq!(
        resolve(input.clone())["wallets"][0]["balanceState"],
        "known"
    );
    other["startDate"] = json!("2026-10-18");
    other["endDate"] = json!("2026-10-19");
    input["statementProofs"][1] = other;
    assert_eq!(
        resolve(input)["wallets"][0]["balanceState"],
        "balance_unknown"
    );
}
#[test]
fn reviewed_effect_is_excluded_from_activity_identity_but_purpose_is_bound() {
    let input = fixture();
    let before = preview(&input);
    let mut changed = input;
    changed["observations"][0]["reviewedLedgerEffect"] = json!(true);
    changed["observations"][0]["ledgerEffect"] = json!({"accountId":"account","date":"2026-10-15","amount":{"minorUnits":"-100","currency":"USD"},"categoryId":"category","payeeName":null,"notes":null,"splits":[]});
    assert_eq!(
        preview(&changed)["activityManifest"],
        before["activityManifest"]
    );
    changed["observations"][0]["eventType"] = json!("gift");
    assert_ne!(
        preview(&changed)["activityManifest"],
        before["activityManifest"]
    );
}
#[test]
fn pending_activity_is_not_attested_and_duplicate_deliveries_require_confirmed_link() {
    let mut input = fixture();
    input["observations"][0]["status"] = json!("pending");
    assert_eq!(preview(&input)["activityManifest"], json!([]));
    let mut input = fixture();
    let mut duplicate = input["observations"][0].clone();
    duplicate["id"] = json!("wallet-2");
    input["observations"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    input["relationships"] = json!([{"id":"dup","fromId":"wallet-1","toId":"wallet-2","kind":"same_event","state":"confirmed","allocatedAmount":null,"partial":false,"score":100,"reasonCodes":[],"evidenceIds":["doc-wallet"]}]);
    assert_eq!(
        preview(&input)["activityManifest"]
            .as_array()
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn malformed_statement_contracts_and_checked_overflow_are_rejected() {
    for change in [
        json!({"authorityKind":"provider_authenticated"}),
        json!({"calendarBasis":"utc"}),
        json!({"startDate":"2026-02-30"}),
        json!({"openingBalance":null,"closingBalance":null}),
        json!({"openingBalance":{"minorUnits":"-1","currency":"USD"}}),
        json!({"currency":"EUR"}),
        json!({"reviewedAt":"today"}),
        json!({"proofId":""}),
    ] {
        let mut input = fixture();
        input["statementProofs"][0]
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        let parsed = serde_json::from_value(input).unwrap();
        assert!(resolve_transaction_evidence(&parsed).is_err());
    }
    let mut input = attest(fixture());
    input["observations"][0]["direction"] = json!("inflow");
    input["statementProofs"][0]["openingBalance"]["minorUnits"] = json!(i64::MAX.to_string());
    assert!(resolve_transaction_evidence(&serde_json::from_value(input).unwrap()).is_err());
}
#[test]
fn transitive_reviewed_duplicates_canonicalize_once() {
    let mut input = fixture();
    for id in ["wallet-2", "wallet-3"] {
        let mut duplicate = input["observations"][0].clone();
        duplicate["id"] = json!(id);
        input["observations"]
            .as_array_mut()
            .unwrap()
            .push(duplicate);
    }
    input["relationships"] = json!([{"id":"dup1","fromId":"wallet-1","toId":"wallet-3","kind":"same_event","state":"confirmed","allocatedAmount":null,"partial":false,"score":100,"reasonCodes":[],"evidenceIds":["doc-wallet"]},{"id":"dup2","fromId":"wallet-2","toId":"wallet-3","kind":"same_event","state":"confirmed","allocatedAmount":null,"partial":false,"score":100,"reasonCodes":[],"evidenceIds":["doc-wallet"]}]);
    let p = preview(&input);
    assert_eq!(p["activityManifest"].as_array().unwrap().len(), 1);
    assert_eq!(p["outflows"]["minorUnits"], "100");
}
#[test]
fn compatible_components_bind_all_proofs_and_their_sources() {
    let mut input = attest(fixture());
    let mut duplicate = input["statementProofs"][0].clone();
    duplicate["proofId"] = json!("second");
    duplicate["statement"]["documentId"] = json!("second-doc");
    input["statementProofs"]
        .as_array_mut()
        .unwrap()
        .push(duplicate);
    let output = resolve(input);
    for anchor in output["wallets"][0]["balanceAnchors"].as_array().unwrap() {
        assert_eq!(anchor["proofIds"], json!(["proof", "second"]));
        assert_eq!(anchor["evidenceIds"], json!(["doc-wallet", "second-doc"]));
    }
}
#[test]
fn later_day_can_spend_known_closing_balance_after_same_day_order_unknown() {
    let mut input = fixture();
    let mut incoming = input["observations"][0].clone();
    incoming["id"] = json!("inflow");
    incoming["externalEventId"] = json!("inflow");
    incoming["direction"] = json!("inflow");
    incoming["amount"]["minorUnits"] = json!("200");
    input["observations"].as_array_mut().unwrap().push(incoming);
    let mut later = input["observations"][0].clone();
    later["id"] = json!("later");
    later["externalEventId"] = json!("later");
    later["date"] = json!("2026-10-16");
    input["observations"].as_array_mut().unwrap().push(later);
    input["statementProofs"][0]["openingBalance"]["minorUnits"] = json!("0");
    input["statementProofs"][0]["closingBalance"]["minorUnits"] = json!("0");
    let output = resolve(attest(input));
    assert_eq!(
        output["wallets"][0]["coverage"]["blockedObservationIds"],
        json!(["wallet-1"])
    );
}
#[test]
fn wallet_attestations_leave_no_proof_fixture_serialization_and_hash_unchanged() {
    let input: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence.json"
    ))
    .unwrap();
    let expected: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-result.json"
    ))
    .unwrap();
    let parsed: balanceframe_core_protocol::TransactionEvidenceRequest =
        serde_json::from_value(input.clone()).unwrap();
    assert_eq!(serde_json::to_value(&parsed).unwrap(), input);
    assert_eq!(resolve(input), expected);
}
#[test]
fn local_statement_failure_does_not_block_unrelated_bank_projection() {
    let mut input = fixture();
    input["statementProofs"][0]["activityManifest"] = json!([]);
    let reference: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence-projection.json"
    ))
    .unwrap();
    for o in reference["observations"].as_array().unwrap() {
        let mut o = o.clone();
        o["id"] = json!(format!("bank-{}", o["id"].as_str().unwrap()));
        o["externalEventId"] = json!("independent");
        o["amount"]["minorUnits"] = json!("1200");
        input["observations"].as_array_mut().unwrap().push(o);
    }
    let mut link = reference["relationships"][0].clone();
    link["fromId"] = json!("bank-wallet-1");
    link["toId"] = json!("bank-bank-1");
    input["relationships"].as_array_mut().unwrap().push(link);
    let output = resolve(input);
    let event = output["events"]
        .as_array()
        .unwrap()
        .iter()
        .find(|event| {
            event["observationIds"]
                .as_array()
                .unwrap()
                .contains(&json!("bank-wallet-1"))
        })
        .unwrap();
    assert!(event["projectionObservation"].is_object());
    assert_eq!(
        output["wallets"][0]["coverage"]["blockedObservationIds"],
        json!(["wallet-1"])
    );
}
#[test]
fn statement_limits_reject_global_manifest_work_and_duplicate_proof_ids() {
    let mut input = fixture();
    let proof = input["statementProofs"][0].clone();
    input["statementProofs"] = json!(vec![proof.clone(); 101]);
    assert!(resolve_transaction_evidence(&serde_json::from_value(input).unwrap()).is_err());
    let mut input = fixture();
    input["statementProofs"].as_array_mut().unwrap().push(proof);
    assert!(resolve_transaction_evidence(&serde_json::from_value(input).unwrap()).is_err());
    let mut input = attest(fixture());
    let entry = input["statementProofs"][0]["activityManifest"][0].clone();
    let mut proofs = vec![];
    for i in 0..3 {
        let mut proof = input["statementProofs"][0].clone();
        proof["proofId"] = json!(format!("p{i}"));
        proof["activityManifest"] = json!(vec![entry.clone(); 10000]);
        proofs.push(proof);
    }
    input["statementProofs"] = json!(proofs);
    assert!(resolve_transaction_evidence(&serde_json::from_value(input).unwrap()).is_err());
}
#[test]
fn unknown_same_day_order_is_inspectable_on_covered_interval() {
    let mut input = fixture();
    let mut incoming = input["observations"][0].clone();
    incoming["id"] = json!("inflow");
    incoming["externalEventId"] = json!("inflow");
    incoming["direction"] = json!("inflow");
    input["observations"].as_array_mut().unwrap().push(incoming);
    input["statementProofs"][0]["openingBalance"]["minorUnits"] = json!("0");
    input["statementProofs"][0]["closingBalance"]["minorUnits"] = json!("0");
    let output = resolve(attest(input));
    assert_eq!(
        output["wallets"][0]["coverage"]["intervals"][0]["state"],
        "covered"
    );
    assert_eq!(
        output["wallets"][0]["coverage"]["intervals"][0]["reasonCodes"],
        json!(["wallet_statement_order_unknown"])
    );
}
#[test]
fn preview_rejects_invalid_scope_wallet_descriptors_and_periods() {
    let input = fixture();
    for change in [
        json!({"contractVersion":"2"}),
        json!({"walletId":"missing"}),
        json!({"startDate":"2026-02-30"}),
        json!({"startDate":"2026-12-01"}),
    ] {
        let mut request = json!({"contractVersion":"1","evidence":input,"walletId":"wallet","startDate":"2026-10-15","endDate":"2026-10-16"});
        request
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(balanceframe_core_protocol::derive_wallet_statement_preview(
            &serde_json::from_value(request).unwrap()
        )
        .is_err());
    }
    for (field, value) in [
        ("currency", json!("usd")),
        ("materializedAccountId", json!("")),
        (
            "openingBalance",
            json!({"minorUnits":"-1","currency":"USD"}),
        ),
    ] {
        let mut bad = input.clone();
        bad["wallets"][0][field] = value;
        let request = json!({"contractVersion":"1","evidence":bad,"walletId":"wallet","startDate":"2026-10-15","endDate":"2026-10-16"});
        assert!(
            balanceframe_core_protocol::derive_wallet_statement_preview(
                &serde_json::from_value(request).unwrap()
            )
            .is_err(),
            "{field}"
        );
    }
}
#[test]
fn explicit_supersession_is_canonical_and_cycles_forks_and_unreviewed_duplicates_refuse() {
    let mut input = fixture();
    for id in ["wallet-2", "wallet-3"] {
        let mut o = input["observations"][0].clone();
        o["id"] = json!(id);
        input["observations"].as_array_mut().unwrap().push(o);
    }
    let link = |id: &str, from: &str, to: &str| json!({"id":id,"fromId":from,"toId":to,"kind":"supersession","state":"confirmed","allocatedAmount":null,"partial":false,"score":100,"reasonCodes":[],"evidenceIds":["doc-wallet"]});
    input["relationships"] = json!([
        link("a", "wallet-1", "wallet-2"),
        link("b", "wallet-2", "wallet-3")
    ]);
    assert_eq!(
        preview(&input)["activityManifest"][0]["observationId"],
        "wallet-3"
    );
    for links in [
        json!([]),
        json!([
            link("a", "wallet-1", "wallet-2"),
            link("b", "wallet-1", "wallet-3")
        ]),
        json!([
            link("a", "wallet-1", "wallet-2"),
            link("b", "wallet-2", "wallet-1")
        ]),
    ] {
        input["relationships"] = links;
        let request = json!({"contractVersion":"1","evidence":input,"walletId":"wallet","startDate":"2026-10-15","endDate":"2026-10-16"});
        assert!(balanceframe_core_protocol::derive_wallet_statement_preview(
            &serde_json::from_value(request).unwrap()
        )
        .is_err());
    }
}
#[test]
fn external_card_pass_through_is_excluded_and_materialized_wallet_stays_mapped() {
    let mut input = fixture();
    let base: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/transaction-evidence.json"
    ))
    .unwrap();
    input["observations"] = base["observations"].clone();
    input["observations"][0]["walletId"] = json!("wallet");
    input["wallets"][0]["materializedAccountId"] = json!("mapped");
    input["statementProofs"][0]["closingBalance"] = Value::Null;
    assert_eq!(preview(&input)["activityManifest"], json!([]));
    assert_eq!(
        preview(&input)["excludedObservationIds"],
        json!(["wallet-1"])
    );
    assert_eq!(resolve(input)["wallets"][0]["projection"], "materialized");
}
#[test]
fn invalid_statement_identity_manifest_and_endpoint_cases_fail_closed() {
    for change in [
        json!({"proofId":"a\u{0000}b"}),
        json!({"actorId":""}),
        json!({"membershipId":""}),
        json!({"policyVersion":""}),
        json!({"statement":{"documentId":"doc","contentHash":"BAD","parserVersion":"1"}}),
        json!({"activityManifest":[{"observationId":"","documentId":"doc","contentHash":"a".repeat(64),"parserVersion":"1","normalizedFieldsHash":"b".repeat(64)}]}),
        json!({"openingBalance":{"minorUnits":"0","currency":"EUR"}}),
    ] {
        let mut input = fixture();
        input["statementProofs"][0]
            .as_object_mut()
            .unwrap()
            .extend(change.as_object().unwrap().clone());
        assert!(resolve_transaction_evidence(&serde_json::from_value(input).unwrap()).is_err());
    }
    let mut input = attest(fixture());
    input["statementProofs"][0]["openingBalance"] = Value::Null;
    input["observations"][0]["direction"] = json!("inflow");
    input["statementProofs"][0]["closingBalance"]["minorUnits"] = json!("0");
    input["statementProofs"][0]["activityManifest"] = preview(&input)["activityManifest"].clone();
    assert_eq!(resolve(input)["wallets"][0]["balanceAnchors"], json!([]));
}
#[test]
fn review_instants_must_be_canonical_utc_before_becoming_source_observations() {
    for time in [
        "2026-10-17T00:00:00+00:00",
        "2026-10-17T00:00:60Z",
        "2026-10-17T00:00:00.1234567890Z",
    ] {
        let mut input = attest(fixture());
        input["statementProofs"][0]["reviewedAt"] = json!(time);
        assert!(
            resolve_transaction_evidence(&serde_json::from_value(input).unwrap()).is_err(),
            "{time}"
        );
    }
}

#[test]
fn canonical_statement_preview_and_result_are_shared_cross_language_fixtures() {
    let input = fixture();
    let expected: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/wallet-statement-preview.json"
    ))
    .unwrap();
    assert_eq!(preview(&input), expected);
    let expected: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/wallet-statement-result.json"
    ))
    .unwrap();
    let output = resolve(input);
    assert_eq!(output, expected);
    for source in output["wallets"][0]["anchorObservations"]
        .as_array()
        .unwrap()
    {
        let typed: balanceframe_core_protocol::SourceObservation =
            serde_json::from_value(source.clone()).unwrap();
        assert_eq!(serde_json::to_value(typed).unwrap(), *source);
        let mut invalid = source.clone();
        invalid["walletBalanceAnchor"] = Value::Null;
        assert!(
            serde_json::from_value::<balanceframe_core_protocol::SourceObservation>(invalid)
                .is_err()
        );
    }
}

#[test]
fn canonical_fractional_review_timestamp_round_trips_without_weakening_source_contract() {
    let mut input = attest(fixture());
    input["statementProofs"][0]["reviewedAt"] = json!("2026-10-17T00:00:00.123456789Z");
    assert_eq!(
        resolve(input)["wallets"][0]["anchorObservations"][0]["observedAt"],
        "2026-10-17T00:00:00.123456789Z"
    );
}
#[test]
fn uncovered_inflow_cannot_bypass_unknown_wallet_dependency() {
    let mut input = fixture();
    input["statementProofs"][0]["activityManifest"] = json!([]);
    input["observations"][0]["direction"] = json!("inflow");
    input["observations"][0]["kind"] = json!("wallet_refund");
    let output = resolve(input);
    assert_eq!(
        output["wallets"][0]["coverage"]["blockedObservationIds"],
        json!(["wallet-1"])
    );
}
