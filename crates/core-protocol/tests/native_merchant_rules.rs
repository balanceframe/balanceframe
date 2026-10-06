use balanceframe_core_protocol::{
    analyze_deterministic, plan_create_rule, plan_set_category, simulate_create_rule_plan,
    verify_mutation, verify_rule_mutation, CreateRulePlan, CreateRuleRequest,
    DeterministicAnalysisRequest, MerchantScope, MutationPlan, ProtocolSnapshot, RuleReviewContext,
};
use balanceframe_financial_core::{Money, Rule};
use serde_json::{json, Value};

// Reuse the canonical merchant source; only adapt its explicit text states to
// the existing rule API's legacy snapshot until that API is cut over.
fn snapshot() -> ProtocolSnapshot {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/merchant-intelligence.json"
    ))
    .unwrap();
    let request = &fixture["request"];
    let representative: ProtocolSnapshot = serde_json::from_str(include_str!(
        "../../../protocol/fixtures/representative.json"
    ))
    .unwrap();
    let mut account = representative.accounts[0].clone();
    account.id = "account-checking".into();
    let mut transactions = request["transactions"].as_array().unwrap().clone();
    for transaction in &mut transactions {
        transaction["importedPayee"] = transaction["importedPayee"]["value"].clone();
        transaction["notes"] = transaction["notes"]["value"].clone();
        transaction["categoryName"] = Value::Null;
        transaction["tags"] = json!([]);
        transaction["subtransactions"] = json!([]);
    }
    serde_json::from_value(json!({
        "schemaVersion": "1", "actualVersion": "26.10.0",
        "snapshotDate": "2026-10-04T12:00:00Z",
        "accounts": [account], "transactions": transactions,
        "payees": request["payees"], "categories": request["categories"],
        "rules": [], "schedules": [], "budgets": [], "tags": []
    }))
    .unwrap()
}

fn request(payee_id: &str) -> CreateRuleRequest {
    CreateRuleRequest {
        rule_name: "Categorize stable merchant".into(),
        payee_id: payee_id.into(),
        category_id: "category-food".into(),
        review_context: RuleReviewContext {
            scope: MerchantScope {
                space_id: "space-fixture".into(),
                budget_id: "budget-fixture".into(),
                connection_id: "connection-fixture".into(),
            },
            source_facts_hash: "facts-1".into(),
            evidence_key: None,
            evidence_revision: "evidence-1".into(),
            merchant_policy_version: "merchant-policy-1".into(),
            visibility_hash: "visibility-1".into(),
            expires_at: "2026-10-04T12:30:00Z".into(),
        },
    }
}

fn plan(snapshot: &ProtocolSnapshot, payee_id: &str) -> CreateRulePlan {
    plan_create_rule(&request(payee_id), snapshot).unwrap()
}

fn native_rule(payee_id: &str, category_id: &str) -> Rule {
    Rule {
        id: "rule-created".into(),
        name: "Display-only rule name".into(),
        order: 1,
        trigger: json!({
            "stage": "post", "conditionsOp": "and",
            "conditions": [{"field": "payee", "op": "is", "value": payee_id}]
        }),
        actions: json!([{"op": "set", "field": "category", "value": category_id}]),
        inactive: false,
    }
}

#[test]
fn native_payload_preserves_opaque_payee_id_and_actual_category_action() {
    let mut source = snapshot();
    source.payees[0].id = "Payee-MARKET/CaseSensitive".into();
    source.transactions[0].payee_id = Some(source.payees[0].id.clone());
    let planned = plan(&source, &source.payees[0].id);
    assert_eq!(
        planned.trigger,
        json!({"stage": "post", "conditionsOp": "and", "conditions": [
            {"field": "payee", "op": "is", "value": "Payee-MARKET/CaseSensitive"}
        ]})
    );
    assert_eq!(
        planned.actions,
        json!([{"op": "set", "field": "category", "value": "category-food"}])
    );
    assert_eq!(planned.conditions[0].value, "Payee-MARKET/CaseSensitive");
}

#[test]
fn duplicate_display_names_do_not_expand_simulation_or_verify_the_wrong_id() {
    let mut source = snapshot();
    source.payees[1].name = source.payees[0].name.clone();
    let mut other = source.transactions[0].clone();
    other.id = "tx-other-identity".into();
    other.payee_id = Some("payee-other".into());
    source.transactions.push(other);
    let planned = plan(&source, "payee-market");
    let simulation = simulate_create_rule_plan(&planned, &source).unwrap();
    assert_eq!(simulation.transactions_affected, vec!["tx-source"]);
    assert_eq!(simulation.transactions_matched, 1);
    source.rules = vec![native_rule("payee-other", "category-food")];
    assert!(!verify_rule_mutation(&planned, &source).verified);
    source.rules = vec![native_rule("payee-market", "category-food")];
    assert!(verify_rule_mutation(&planned, &source).verified);
}

#[test]
fn payee_and_transaction_display_renames_do_not_change_identity_matching() {
    let mut source = snapshot();
    let planned = plan(&source, "payee-market");
    source.payees[0].name = "Renamed in Actual".into();
    source.transactions[0].payee_name = Some("Editable imported display".into());
    assert_eq!(
        simulate_create_rule_plan(&planned, &source)
            .unwrap()
            .transactions_affected,
        vec!["tx-source"]
    );
    source.rules = vec![native_rule("payee-market", "category-food")];
    assert!(verify_rule_mutation(&planned, &source).verified);
}

#[test]
fn simulation_walks_recursive_children_once_and_reports_exact_category_diffs_and_money() {
    let mut source = snapshot();
    let mut leaf = source.transactions[0].clone();
    leaf.id = "tx-leaf".into();
    leaf.amount = Money::new(i64::MIN, "JPY");
    let mut unchanged = leaf.clone();
    unchanged.id = "tx-already-categorized".into();
    unchanged.category_id = Some("category-food".into());
    unchanged.category_name = Some("Food".into());
    unchanged.amount = Money::new(i64::MAX, "KWD");
    let mut intermediate = leaf.clone();
    intermediate.id = "tx-intermediate-parent".into();
    intermediate.subtransactions = vec![leaf, unchanged];
    let mut parent = source.transactions[0].clone();
    parent.id = "tx-root-parent".into();
    parent.subtransactions = vec![intermediate];
    source.transactions = vec![parent];
    let simulation = simulate_create_rule_plan(&plan(&source, "payee-market"), &source).unwrap();
    assert_eq!(simulation.transactions_matched, 2);
    assert_eq!(
        simulation.transactions_affected,
        vec!["tx-already-categorized", "tx-leaf"]
    );
    assert_eq!(
        simulation.category_distribution.get("category-food"),
        Some(&2)
    );
    let changed = simulation
        .examples
        .iter()
        .find(|example| example.tx_id == "tx-leaf")
        .unwrap();
    assert!(changed.would_change);
    assert_eq!(changed.amount, Money::new(i64::MIN, "JPY"));
    let unchanged = simulation
        .examples
        .iter()
        .find(|example| example.tx_id == "tx-already-categorized")
        .unwrap();
    assert!(!unchanged.would_change);
    assert_eq!(unchanged.amount, Money::new(i64::MAX, "KWD"));
}

#[test]
fn contradictions_follow_exact_payee_ids_not_display_names() {
    let mut source = snapshot();
    source.payees[1].name = source.payees[0].name.clone();
    source.rules = vec![native_rule("payee-other", "category-bills")];
    let planned = plan(&source, "payee-market");
    assert!(simulate_create_rule_plan(&planned, &source)
        .unwrap()
        .conflicts
        .is_empty());
    source.rules = vec![native_rule("payee-market", "category-bills")];
    assert_eq!(
        simulate_create_rule_plan(&planned, &source)
            .unwrap()
            .conflicts,
        vec!["rule-created"]
    );
    source.rules[0].inactive = true;
    assert!(simulate_create_rule_plan(&planned, &source)
        .unwrap()
        .conflicts
        .is_empty());
}

#[test]
fn native_rule_conflicts_disclose_exact_ledger_name_rules_in_native_order() {
    let mut source = snapshot();
    let mut other_identity = source.transactions[0].clone();
    other_identity.id = "tx-other-identity".into();
    other_identity.payee_id = Some("payee-other".into());
    source.transactions.push(other_identity);
    source.payees[1].name = source.payees[0].name.clone();
    source.rules = [
        ("name-post-z", 20, json!("post"), false),
        ("name-default", 10, Value::Null, false),
        ("name-post-a", 20, json!("post"), false),
        ("name-inactive", 0, json!("post"), true),
    ]
    .into_iter()
    .map(|(id, order, stage, inactive)| {
        let mut rule = native_rule("payee-market", "category-bills");
        rule.id = id.into();
        rule.order = order;
        rule.inactive = inactive;
        rule.trigger = json!({"stage": stage, "conditionsOp": "and", "conditions": [
            {"field": "payee_name", "op": "is", "value": "Corner Market", "type": "string"}
        ]});
        rule
    })
    .collect();

    let planned = plan(&source, "payee-market");
    let simulation = simulate_create_rule_plan(&planned, &source).unwrap();
    assert_eq!(
        simulation.conflicts,
        vec!["name-default", "name-post-a", "name-post-z"]
    );
    assert_eq!(simulation.transactions_affected, vec!["tx-source"]);
    assert_eq!(simulation.transactions_matched, 1);
    assert_eq!(
        simulation.category_distribution.get("category-food"),
        Some(&1)
    );
    assert_eq!(simulation.examples.len(), 1);
    assert_eq!(
        simulation.examples[0].payee.as_deref(),
        Some("Corner Market")
    );
    assert_eq!(simulation.examples[0].amount, Money::new(-100, "USD"));
    assert!(simulation.examples[0].would_change);
    assert_eq!(
        planned.trigger["conditions"][0],
        json!({
            "field": "payee", "op": "is", "value": "payee-market"
        })
    );
    assert!(!verify_rule_mutation(&planned, &source).verified);
    source.rules.reverse();
    assert_eq!(
        simulate_create_rule_plan(&planned, &source).unwrap(),
        simulation
    );
}

#[test]
fn native_rule_conflicts_evaluate_complete_supported_predicates_on_reviewed_population() {
    let mut source = snapshot();
    source.transactions[0].category_id = Some("category-bills".into());
    let cases = [
        (
            "and-account-match",
            "and",
            json!([
                {"field": "payee", "op": "is", "value": "payee-market"},
                {"field": "account", "op": "is", "value": "account-checking"}
            ]),
        ),
        (
            "and-account-miss",
            "and",
            json!([
                {"field": "payee", "op": "is", "value": "payee-market"},
                {"field": "account", "op": "is", "value": "account-other"}
            ]),
        ),
        (
            "or-account-match",
            "or",
            json!([
                {"field": "payee", "op": "is", "value": "payee-other"},
                {"field": "account", "op": "is", "value": "account-checking"}
            ]),
        ),
        (
            "or-all-miss",
            "or",
            json!([
                {"field": "payee", "op": "is", "value": "payee-other"},
                {"field": "account", "op": "is", "value": "account-other"}
            ]),
        ),
        (
            "account-category-one-of-match",
            "and",
            json!([
                {"field": "account", "op": "oneOf", "value": ["account-other", "account-checking"], "type": "id", "options": {}},
                {"field": "category", "op": "oneOf", "value": ["category-other", "category-bills"]}
            ]),
        ),
        (
            "account-one-of-miss",
            "and",
            json!([
                {"field": "payee", "op": "is", "value": "payee-market"},
                {"field": "account", "op": "oneOf", "value": ["account-other"]}
            ]),
        ),
        (
            "category-one-of-miss",
            "and",
            json!([
                {"field": "payee", "op": "is", "value": "payee-market"},
                {"field": "category", "op": "oneOf", "value": ["category-other"]}
            ]),
        ),
        (
            "category-scalar-match",
            "and",
            json!([
                {"field": "category", "op": "is", "value": "category-bills"}
            ]),
        ),
        (
            "category-null-miss",
            "and",
            json!([
                {"field": "payee", "op": "is", "value": "payee-market"},
                {"field": "category", "op": "is", "value": null}
            ]),
        ),
        (
            "payee-null-miss",
            "and",
            json!([
                {"field": "payee", "op": "is", "value": null}
            ]),
        ),
        (
            "payee-id-case-miss",
            "and",
            json!([
                {"field": "payee", "op": "is", "value": "PAYEE-MARKET"}
            ]),
        ),
        (
            "payee-name-case-match",
            "and",
            json!([
                {"field": "payee_name", "op": "is", "value": "cOrNeR mArKeT", "options": null}
            ]),
        ),
    ];
    source.rules = cases
        .into_iter()
        .enumerate()
        .map(|(index, (id, operator, conditions))| {
            let mut rule = native_rule("payee-market", "category-other");
            rule.id = id.into();
            rule.order = index as u32;
            rule.trigger =
                json!({"stage": "post", "conditionsOp": operator, "conditions": conditions});
            rule
        })
        .collect();
    source.rules.reverse();
    let simulation = simulate_create_rule_plan(&plan(&source, "payee-market"), &source).unwrap();
    assert_eq!(
        simulation.conflicts,
        vec![
            "and-account-match",
            "or-account-match",
            "account-category-one-of-match",
            "category-scalar-match",
            "payee-name-case-match"
        ]
    );
    assert_eq!(simulation.transactions_affected, vec!["tx-source"]);
    assert_eq!(
        simulation.examples[0].current_category.as_deref(),
        Some("category-bills")
    );
    assert!(simulation.examples[0].would_change);

    source.transactions[0].category_id = None;
    source.rules.retain(|rule| rule.id == "category-null-miss");
    let uncategorized = simulate_create_rule_plan(&plan(&source, "payee-market"), &source).unwrap();
    assert_eq!(uncategorized.conflicts, vec!["category-null-miss"]);

    source.transactions[0].payee_id = Some("payee-other".into());
    let outside_population =
        simulate_create_rule_plan(&plan(&source, "payee-market"), &source).unwrap();
    assert!(outside_population.conflicts.is_empty());
    assert!(outside_population.transactions_affected.is_empty());
}

#[test]
fn native_rule_conflicts_disclose_unsupported_predicates_without_inventing_impact() {
    let mut source = snapshot();
    let triggers = [
        (
            "unsupported-regex",
            json!({"stage": "post", "conditionsOp": "and", "conditions": [
                {"field": "payee_name", "op": "matches", "value": ".*Market"}
            ]}),
        ),
        (
            "unsupported-or-branch",
            json!({"stage": null, "conditionsOp": "or", "conditions": [
                {"field": "account", "op": "is", "value": "account-other"},
                {"field": "notes", "op": "contains", "value": "receipt"}
            ]}),
        ),
        (
            "unsupported-options",
            json!({"stage": "post", "conditionsOp": "and", "conditions": [
                {"field": "payee_name", "op": "is", "value": "Corner Market", "options": {"caseSensitive": true}}
            ]}),
        ),
    ];
    source.rules = triggers
        .into_iter()
        .enumerate()
        .map(|(index, (id, trigger))| {
            let mut rule = native_rule("payee-market", "category-bills");
            rule.id = id.into();
            rule.order = index as u32;
            rule.trigger = trigger;
            rule
        })
        .collect();
    let mut inactive = source.rules[0].clone();
    inactive.id = "inactive-unsupported".into();
    inactive.inactive = true;
    source.rules.push(inactive);
    source.rules.reverse();

    let simulation = simulate_create_rule_plan(&plan(&source, "payee-market"), &source).unwrap();
    assert_eq!(
        simulation.conflicts,
        vec![
            "unsupported-regex",
            "unsupported-or-branch",
            "unsupported-options"
        ]
    );
    assert_eq!(simulation.transactions_matched, 1);
    assert_eq!(simulation.transactions_affected, vec!["tx-source"]);
    assert_eq!(simulation.examples.len(), 1);
    assert_eq!(simulation.examples[0].amount, Money::new(-100, "USD"));
    assert_eq!(
        simulation.category_distribution.get("category-food"),
        Some(&1)
    );

    source.transactions[0].payee_id = Some("payee-other".into());
    let no_impact = simulate_create_rule_plan(&plan(&source, "payee-market"), &source).unwrap();
    assert_eq!(no_impact.transactions_matched, 0);
    assert!(no_impact.conflicts.is_empty());
    assert!(no_impact.examples.is_empty());
    assert!(no_impact.category_distribution.is_empty());
}

#[test]
fn postconditions_reject_inactive_missing_deleted_or_substituted_targets() {
    let source = snapshot();
    let planned = plan(&source, "payee-market");
    let mut created = source.clone();
    created.rules = vec![native_rule("payee-market", "category-food")];
    assert!(verify_rule_mutation(&planned, &created).verified);
    let mut inactive = created.clone();
    inactive.rules[0].inactive = true;
    assert!(!verify_rule_mutation(&planned, &inactive).verified);
    let mut missing_payee = created.clone();
    missing_payee
        .payees
        .retain(|payee| payee.id != "payee-market");
    assert!(!verify_rule_mutation(&planned, &missing_payee).verified);
    let mut missing_category = created.clone();
    missing_category
        .categories
        .retain(|category| category.id != "category-food");
    assert!(!verify_rule_mutation(&planned, &missing_category).verified);
    let mut deleted_category = created.clone();
    deleted_category.categories[0].deleted = true;
    assert!(!verify_rule_mutation(&planned, &deleted_category).verified);
    let mut legacy_display_rule = created;
    legacy_display_rule.rules[0].trigger["conditions"][0]["field"] = json!("payee_name");
    legacy_display_rule.rules[0].trigger["conditions"][0]["value"] = json!("Corner Market");
    assert!(!verify_rule_mutation(&planned, &legacy_display_rule).verified);
}

#[test]
fn plan_hash_ignores_capture_time_but_binds_relevant_source_and_reviewed_population() {
    let source = snapshot();
    let original = plan(&source, "payee-market");
    let mut recaptured = source.clone();
    recaptured.snapshot_date = "2026-10-04T12:01:00Z".into();
    recaptured.actual_downloaded_at = Some("2026-10-04T12:01:00Z".into());
    assert_eq!(original.hash, plan(&recaptured, "payee-market").hash);
    let mut changed = source.clone();
    changed.transactions[0].category_id = Some("category-bills".into());
    assert_ne!(original.hash, plan(&changed, "payee-market").hash);
    let mut changed = source.clone();
    changed.transactions[0].amount = Money::new(-101, "USD");
    assert_ne!(original.hash, plan(&changed, "payee-market").hash);
    let mut changed = source.clone();
    changed.payees[0].name = "Renamed source payee".into();
    assert_ne!(original.hash, plan(&changed, "payee-market").hash);
    let mut changed = source.clone();
    changed.categories[0].name = "Renamed source category".into();
    assert_ne!(original.hash, plan(&changed, "payee-market").hash);
    let mut changed = source.clone();
    let mut added = changed.transactions[0].clone();
    added.id = "tx-new-impact".into();
    changed.transactions.push(added);
    assert_ne!(original.hash, plan(&changed, "payee-market").hash);
    let mut changed = source.clone();
    changed.rules = vec![native_rule("payee-market", "category-bills")];
    let with_rule = plan(&changed, "payee-market");
    assert_ne!(original.hash, with_rule.hash);
    changed.rules[0].order += 1;
    assert_ne!(with_rule.hash, plan(&changed, "payee-market").hash);
}

#[test]
fn planning_and_simulation_reject_unavailable_targets_and_conflicting_source_ids() {
    let source = snapshot();
    let planned = plan(&source, "payee-market");
    for invalid in ["payee", "category", "deleted"] {
        let mut changed = source.clone();
        match invalid {
            "payee" => changed.payees.clear(),
            "category" => changed.categories.clear(),
            _ => changed.categories[0].deleted = true,
        }
        assert!(plan_create_rule(&request("payee-market"), &changed).is_err());
        assert!(simulate_create_rule_plan(&planned, &changed).is_err());
    }
    let mut duplicate = source.clone();
    duplicate
        .transactions
        .push(duplicate.transactions[0].clone());
    assert_eq!(
        simulate_create_rule_plan(&planned, &duplicate)
            .unwrap()
            .transactions_matched,
        1
    );
    duplicate.transactions[1].amount = Money::new(123, "USD");
    assert!(plan_create_rule(&request("payee-market"), &duplicate).is_err());
    assert!(simulate_create_rule_plan(&planned, &duplicate).is_err());
}

#[test]
fn hash_binds_current_evidence_policy_visibility_and_complete_population() {
    let source = snapshot();
    let original = plan(&source, "payee-market");
    for field in ["evidence", "policy", "visibility", "source", "key", "scope"] {
        let mut changed = request("payee-market");
        match field {
            "evidence" => changed.review_context.evidence_revision.push_str("-new"),
            "policy" => changed
                .review_context
                .merchant_policy_version
                .push_str("-new"),
            "visibility" => changed.review_context.visibility_hash.push_str("-new"),
            "source" => changed.review_context.source_facts_hash.push_str("-new"),
            "key" => changed.review_context.evidence_key = Some("evidence-key".into()),
            _ => changed.review_context.scope.connection_id.push_str("-new"),
        }
        assert_ne!(
            original.hash,
            plan_create_rule(&changed, &source).unwrap().hash
        );
    }
    let mut population = source.clone();
    for index in 0..200 {
        let mut transaction = source.transactions[0].clone();
        transaction.id = format!("tx-population-{index:03}");
        population.transactions.push(transaction);
    }
    let planned = plan(&population, "payee-market");
    let simulation = simulate_create_rule_plan(&planned, &population).unwrap();
    assert_eq!(simulation.transactions_affected.len(), 201);
    assert_eq!(simulation.examples.len(), 201);
    population.transactions[200].category_id = Some("category-food".into());
    assert_ne!(planned.hash, plan(&population, "payee-market").hash);
}

#[test]
fn verifier_allows_only_actual_id_metadata_and_rejects_case_substitution_or_extra_effects() {
    let mut source = snapshot();
    let planned = plan(&source, "payee-market");
    source.rules = vec![native_rule("payee-market", "category-food")];
    source.rules[0].trigger["conditions"][0]["type"] = json!("id");
    source.rules[0].actions[0]["type"] = json!("id");
    assert!(verify_rule_mutation(&planned, &source).verified);
    source.rules[0].trigger["conditions"][0]["value"] = json!("PAYEE-MARKET");
    assert!(!verify_rule_mutation(&planned, &source).verified);
    source.rules[0].trigger["conditions"][0]["value"] = json!("payee-market");
    source.rules[0]
        .actions
        .as_array_mut()
        .unwrap()
        .push(json!({"op":"set","field":"notes","value":"extra effect"}));
    assert!(!verify_rule_mutation(&planned, &source).verified);
    let mut malformed = planned.clone();
    malformed.trigger["conditions"][0]["op"] = json!("contains");
    assert!(simulate_create_rule_plan(&malformed, &source).is_err());
}

#[test]
fn legacy_native_shared_sets_keep_all_classifications_when_max_results_limits_explanations() {
    let mut source = snapshot();
    source.transactions = (0..210)
        .map(|index| {
            let mut row = source.transactions[0].clone();
            row.id = format!("legacy-candidate-{index:03}");
            row.imported_id = None;
            row.payee_id = Some(format!("distinct-payee-{index:03}"));
            row.payee_name = Some(format!("Distinct merchant {index:03}"));
            row
        })
        .collect();
    source.payees = source
        .transactions
        .iter()
        .map(|row| balanceframe_financial_core::Payee {
            id: row.payee_id.clone().unwrap(),
            name: row.payee_name.clone().unwrap(),
            transfer_account_id: None,
            mtid: None,
        })
        .collect();
    let ids: Vec<_> = (0..64)
        .map(|index| format!("legacy-rule-{index:03}"))
        .collect();
    source.rules = ids
        .iter()
        .rev()
        .map(|id| Rule {
            id: id.clone(),
            name: id.clone(),
            order: 1,
            inactive: false,
            trigger: json!({"stage": null, "conditionsOp": "and", "conditions": [
                {"field": "account", "op": "is", "value": "account-checking"},
                {"field": "category", "op": "is", "value": null}
            ]}),
            actions: json!([{"field": "category", "op": "set", "value": "category-food"}]),
        })
        .collect();
    let analyze = |source: &ProtocolSnapshot, max: Value| {
        let request: DeterministicAnalysisRequest = serde_json::from_value(json!({
            "snapshot": source, "options": {"includePending": false, "includeCleared": true, "maxResults": max}
        })).unwrap();
        serde_json::to_value(analyze_deterministic(request)).unwrap()["analysis"].clone()
    };
    let full = analyze(&source, Value::Null);
    let limited = analyze(&source, json!(1));
    assert_eq!(limited["nativeRuleBlocks"], json!([{"ruleIds": ids}]));
    assert_eq!(limited["nativeRuleParts"], json!([{"blockIndexes": [0]}]));
    assert_eq!(
        limited["nativeRuleSets"],
        json!([{"orPartIndexes": [], "andPartIndexes": [[0], [0], [0], [0]], "categoryPartIndex": 0}])
    );
    assert_eq!(limited["nativeRuleSets"], full["nativeRuleSets"]);
    assert_eq!(limited["nativeRuleBlocks"], full["nativeRuleBlocks"]);
    assert_eq!(limited["nativeRuleParts"], full["nativeRuleParts"]);
    assert_eq!(
        limited["deterministicClassifications"],
        full["deterministicClassifications"]
    );
    let rows = limited["deterministicClassifications"].as_array().unwrap();
    assert_eq!(rows.len(), 210);
    assert!(rows
        .iter()
        .all(|row| row["proposedCategoryId"] == "category-food"
            && row["proposedCategoryName"] == "Food"
            && row["ruleSetIndex"] == 0
            && row.get("ruleIds").is_none()));
    source.transactions.reverse();
    source.payees.reverse();
    source.rules.reverse();
    let reversed = analyze(&source, json!(1));
    assert_eq!(reversed["nativeRuleSets"], limited["nativeRuleSets"]);
    assert_eq!(reversed["nativeRuleBlocks"], limited["nativeRuleBlocks"]);
    assert_eq!(
        reversed["deterministicClassifications"],
        limited["deterministicClassifications"]
    );
}

fn nested_mutation_snapshot() -> (ProtocolSnapshot, MutationPlan) {
    let mut source = snapshot();
    let mut leaf = source.transactions[0].clone();
    leaf.id = "tx-nested-leaf".into();
    leaf.imported_id = None;
    let planned = plan_set_category(&leaf, &source.categories[0]);
    leaf.category_id = Some(planned.proposed_category_id.clone());
    let mut intermediate = source.transactions[0].clone();
    intermediate.id = "tx-nested-intermediate".into();
    intermediate.imported_id = None;
    intermediate.subtransactions = vec![leaf];
    let mut root = source.transactions[0].clone();
    root.id = "tx-nested-root".into();
    root.imported_id = None;
    root.subtransactions = vec![intermediate];
    source.transactions = vec![root];
    (source, planned)
}

#[test]
fn verify_mutation_reads_unique_recursive_child_and_preserves_fresh_postconditions() {
    let (source, planned) = nested_mutation_snapshot();
    assert!(
        verify_mutation(&planned, &source).verified,
        "an actually applied category on an unflattened recursive child must verify"
    );
    let mut not_applied = source.clone();
    not_applied.transactions[0].category_id = Some(planned.proposed_category_id.clone());
    not_applied.transactions[0].subtransactions[0].subtransactions[0].category_id =
        Some("category-bills".into());
    assert!(
        !verify_mutation(&planned, &not_applied).verified,
        "a parent's category is never proof of the child's approved write"
    );
    let mut deleted_category = source.clone();
    deleted_category.categories[0].deleted = true;
    assert!(!verify_mutation(&planned, &deleted_category).verified);
    let mut missing = source;
    missing.transactions[0].subtransactions[0]
        .subtransactions
        .clear();
    assert!(!verify_mutation(&planned, &missing).verified);
}

#[test]
fn verify_mutation_denies_duplicate_target_identity_across_roots_and_recursive_children() {
    let (original, planned) = nested_mutation_snapshot();
    for location in ["root", "same-branch", "other-branch"] {
        for conflicting in [false, true] {
            let mut source = original.clone();
            let mut duplicate =
                source.transactions[0].subtransactions[0].subtransactions[0].clone();
            if conflicting {
                duplicate.category_id = Some("category-bills".into());
            }
            match location {
                "root" => source.transactions.push(duplicate),
                "same-branch" => source.transactions[0].subtransactions[0]
                    .subtransactions
                    .push(duplicate),
                "other-branch" => {
                    let mut branch = source.transactions[0].subtransactions[0].clone();
                    branch.id = "tx-other-intermediate".into();
                    branch.subtransactions = vec![duplicate];
                    let mut root = source.transactions[0].clone();
                    root.id = "tx-other-root".into();
                    root.subtransactions = vec![branch];
                    source.transactions.push(root);
                }
                _ => unreachable!(),
            }
            assert!(!verify_mutation(&planned, &source).verified,
                "duplicate identity must deny even if one or both categories match: {location}/{conflicting}");
            source.transactions.reverse();
            for root in &mut source.transactions {
                root.subtransactions.reverse();
                for child in &mut root.subtransactions {
                    child.subtransactions.reverse();
                }
            }
            assert!(
                !verify_mutation(&planned, &source).verified,
                "enumeration must not select a favorable duplicate: {location}/{conflicting}"
            );
        }
    }
}
