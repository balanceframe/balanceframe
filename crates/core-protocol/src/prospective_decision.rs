//! Immutable inputs and typed results for prospective financial decisions.

use crate::financial_snapshot::{
    FinancialSnapshot, ObservationKind, ObservationState, SourceObservation,
};
use crate::{evaluate_purchase_with_policy, PurchaseEvaluation, PurchaseEvaluationRequest};
use balanceframe_financial_core::{
    DecisionDataPolicy, DecisionIssue, DecisionIssueCode, DecisionIssueEffect,
    DecisionIssueSeverity, DecisionScope, EvidenceReference, FinancialStateLabel, Money,
    RedactionState, Remediation, Transaction,
};
use serde::{Deserialize, Serialize};

/// The fixed time window supplied for a prospective decision.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionHorizon {
    /// Inclusive beginning of the decision horizon as an RFC 3339 timestamp.
    pub starts_at: String,
    /// Exclusive end of the decision horizon as an RFC 3339 timestamp.
    pub ends_at: String,
}

/// Complete immutable context used to evaluate a prospective decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionContext {
    /// Fixed instant at which eligibility is evaluated.
    pub evaluated_at: String,
    /// Fixed horizon containing the evaluation instant.
    pub horizon: DecisionHorizon,
    /// Complete effective data policy used by the decision.
    pub policy: DecisionDataPolicy,
    /// Version of the effective policy.
    pub policy_version: String,
    /// Content hash of the effective policy.
    pub policy_hash: String,
    /// Identifier of the canonical snapshot used by the decision.
    pub snapshot_id: String,
    /// Content hash of the canonical snapshot.
    pub content_hash: String,
}

/// The effect represented by an immutable prospective claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProspectiveClaimKind {
    /// Funds reserved for a prospective action.
    Reservation,
    /// Funds committed to a known obligation.
    Commitment,
}

/// The supplied lifecycle status of a prospective claim.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum ProspectiveClaimStatus {
    /// The claim is available for eligibility evaluation.
    Active,
    /// The claim has been released and no longer affects a decision.
    Released,
}

/// Immutable normalized input representing a reservation or commitment.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProspectiveClaim {
    /// Stable identifier of the claim.
    pub claim_id: String,
    /// Financial effect represented by the claim.
    pub kind: ProspectiveClaimKind,
    /// Stable identifier of the normalized source record.
    pub source_id: String,
    /// Financial scope affected by the claim.
    pub scope: DecisionScope,
    /// Monetary amount affected by the claim.
    pub amount: Money,
    /// Supplied lifecycle status of the claim.
    pub status: ProspectiveClaimStatus,
    /// Inclusive RFC 3339 instant from which the claim is effective.
    pub effective_from: String,
    /// Optional exclusive RFC 3339 instant at which the claim stops applying.
    pub expires_at: Option<String>,
    /// Visibility permitted for evidence derived from this claim.
    pub visibility: RedactionState,
    /// Policy version against which the claim was normalized.
    pub policy_version: String,
    /// Snapshot identifier against which the claim was normalized.
    pub snapshot_id: String,
}

/// Deterministic aggregation of policy-eligible prospective claims.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProspectiveClaimEvaluation {
    /// Claim identifiers included in the totals, in supplied order.
    pub eligible_claim_ids: Vec<String>,
    /// Checked total of eligible reservations, or `None` when it is unsafe to total them.
    pub reservation_total: Option<Money>,
    /// Checked total of eligible commitments, or `None` when it is unsafe to total them.
    pub commitment_total: Option<Money>,
    /// Blocking or qualifying issues discovered during evaluation.
    pub issues: Vec<DecisionIssue>,
}

/// Readiness of a prospective financial conclusion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum DecisionReadiness {
    /// The decision has enough compatible evidence for an unqualified conclusion.
    Ready,
    /// The decision is available with explicit qualifications.
    Qualified,
    /// One or more safety issues block a conclusion.
    Blocked,
}

/// A semantically labeled monetary amount in a decision state.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionAmount {
    /// Meaning of the amount.
    pub label: FinancialStateLabel,
    /// Scope to which the amount applies.
    pub scope: DecisionScope,
    /// Exact monetary amount.
    pub amount: Money,
}

/// Typed financial state before or after a prospective decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionSemanticState {
    /// Semantically labeled amounts comprising the state.
    pub amounts: Vec<DecisionAmount>,
}

/// An alternative available to the decision consumer.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DecisionAlternative {
    /// Stable identifier of the alternative.
    pub alternative_id: String,
    /// Human-readable description of the alternative.
    pub summary: String,
    /// Financial state that would result from choosing the alternative.
    pub resulting_state: DecisionSemanticState,
}

/// Stable identity and context for a prospective decision result.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProspectiveDecisionMetadata {
    /// Version of this decision contract.
    pub contract_version: String,
    /// Stable identifier of this decision result.
    pub decision_id: String,
    /// Domain kind of decision represented by the payload.
    pub decision_kind: String,
    /// Identifier of the request that produced the decision.
    pub request_id: String,
    /// Correlation identifier spanning related work.
    pub correlation_id: String,
    /// Complete immutable context used to produce the result.
    pub context: DecisionContext,
}

/// Typed domain envelope for a prospective financial decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProspectiveDecisionEnvelope<T> {
    /// Stable decision identity and evaluation context.
    pub metadata: ProspectiveDecisionMetadata,
    /// Whether the conclusion is ready, qualified, or blocked.
    pub readiness: DecisionReadiness,
    /// Semantic financial state before the proposed action.
    pub before: DecisionSemanticState,
    /// Semantic financial state after the proposed action.
    pub after: DecisionSemanticState,
    /// Issues that qualify or block the conclusion.
    pub issues: Vec<DecisionIssue>,
    /// Authorized evidence references supporting the conclusion.
    pub evidence: Vec<EvidenceReference>,
    /// Typed alternatives available to the consumer.
    pub alternatives: Vec<DecisionAlternative>,
    /// RFC 3339 instant after which this result must not be relied upon.
    pub expires_at: String,
    /// Redaction applied to this decision result.
    pub redaction: RedactionState,
    /// Decision-specific typed domain result.
    pub payload: T,
}

/// Immutable inputs for a prospective purchase decision.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProspectivePurchaseEvaluationRequest {
    /// Canonical snapshot whose identity is named by the decision context.
    pub financial_snapshot: FinancialSnapshot,
    /// Fixed policy, snapshot identity, and evaluation time.
    pub context: DecisionContext,
    /// Immutable reservations and commitments relevant to the decision.
    pub claims: Vec<ProspectiveClaim>,
    /// Purchase being evaluated without applying it to the snapshot.
    pub proposed_transaction: Transaction,
    /// Budget category against which to evaluate the purchase.
    pub category_id: String,
    /// Stable identifier of this evaluation request.
    pub request_id: String,
    /// Stable identifier spanning related work.
    pub correlation_id: String,
    /// Stable identifier to place on the resulting decision.
    pub decision_id: String,
    /// Caller-supplied RFC 3339 instant after which the result expires.
    pub valid_until: String,
    /// Redaction applied to the resulting decision.
    pub redaction: RedactionState,
}

/// Evaluates supplied prospective claims against a fixed decision context.
///
/// The function is pure: it consults no clock or external service and does not
/// mutate claim lifecycle state. Invalid identity, time, currency, or arithmetic
/// inputs are reported as blocking issues and are excluded from unsafe totals.
pub fn evaluate_prospective_claims(
    context: &DecisionContext,
    claims: &[ProspectiveClaim],
) -> ProspectiveClaimEvaluation {
    let mut issues = Vec::new();
    let Some(evaluated_at) = valid_context_time(context) else {
        issues.push(blocking_issue(
            DecisionIssueCode::Unknown("invalid_decision_context".into()),
            DecisionScope::Global,
            RedactionState::Visible,
            Vec::new(),
        ));
        return ProspectiveClaimEvaluation {
            eligible_claim_ids: Vec::new(),
            reservation_total: None,
            commitment_total: None,
            issues,
        };
    };

    let duplicate_ids = duplicate_claim_ids(context, claims);
    for claim_id in &duplicate_ids {
        let duplicate_claims: Vec<_> = claims
            .iter()
            .filter(|claim| {
                claim_scope_allowed_by_policy(context, claim) && &claim.claim_id == claim_id
            })
            .collect();
        let redaction = combined_redaction(duplicate_claims.iter().copied());
        let scope = if redaction == RedactionState::Redacted {
            DecisionScope::Global
        } else {
            DecisionScope::Claim(claim_id.clone())
        };
        issues.push(blocking_issue(
            DecisionIssueCode::Unknown("duplicate_claim_id".into()),
            scope,
            redaction,
            evidence_for_claims(duplicate_claims.iter().copied(), redaction),
        ));
    }

    let mut eligible = Vec::new();
    for claim in claims {
        if !claim_scope_allowed_by_policy(context, claim) {
            continue;
        }
        if duplicate_ids.contains(&claim.claim_id) {
            continue;
        }
        if claim.policy_version != context.policy_version {
            issues.push(claim_input_issue("policy_version_mismatch", claim));
            continue;
        }
        if claim.snapshot_id != context.snapshot_id {
            issues.push(claim_input_issue("snapshot_mismatch", claim));
            continue;
        }
        if claim.status != ProspectiveClaimStatus::Active {
            continue;
        }
        if !valid_claim_identity(claim) || claim.amount.is_negative() {
            issues.push(claim_input_issue("invalid_claim_input", claim));
            continue;
        }

        let Some(effective_from) = parse_rfc3339(&claim.effective_from) else {
            issues.push(claim_input_issue("invalid_claim_time", claim));
            continue;
        };
        let expires_at = match claim.expires_at.as_deref() {
            Some(value) => match parse_rfc3339(value) {
                Some(parsed) if parsed > effective_from => Some(parsed),
                _ => {
                    issues.push(claim_input_issue("invalid_claim_time", claim));
                    continue;
                }
            },
            None => None,
        };

        if effective_from <= evaluated_at
            && expires_at.is_none_or(|expires_at| evaluated_at < expires_at)
        {
            eligible.push(claim);
        }
    }

    report_scope_conflicts(&eligible, &mut issues);
    let reservation_total =
        aggregate_kind(ProspectiveClaimKind::Reservation, &eligible, &mut issues);
    let commitment_total = aggregate_kind(ProspectiveClaimKind::Commitment, &eligible, &mut issues);

    ProspectiveClaimEvaluation {
        eligible_claim_ids: eligible
            .iter()
            .map(|claim| claim.claim_id.clone())
            .collect(),
        reservation_total,
        commitment_total,
        issues,
    }
}

/// Evaluates a proposed purchase against an immutable canonical snapshot.
///
/// The payload uses the same internal calculation path as the legacy
/// evaluator, with the complete policy supplied by the decision context.
/// Canonical inputs, claims, and observations are then translated into the
/// immutable before/after state and scoped decision issues.
pub fn evaluate_prospective_purchase(
    request: ProspectivePurchaseEvaluationRequest,
) -> ProspectiveDecisionEnvelope<PurchaseEvaluation> {
    let ProspectivePurchaseEvaluationRequest {
        financial_snapshot,
        context,
        claims,
        proposed_transaction,
        category_id,
        request_id,
        correlation_id,
        decision_id,
        valid_until,
        redaction,
    } = request;

    let claim_evaluation = evaluate_prospective_claims(&context, &claims);
    let mut issues = claim_evaluation.issues;

    if request_id.trim().is_empty()
        || correlation_id.trim().is_empty()
        || decision_id.trim().is_empty()
    {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("invalid_request_identity".into()),
                DecisionScope::Global,
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }

    if financial_snapshot.snapshot_id.trim().is_empty()
        || financial_snapshot.content_hash.trim().is_empty()
    {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("invalid_snapshot_identity".into()),
                DecisionScope::Global,
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }
    if context.snapshot_id != financial_snapshot.snapshot_id {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("snapshot_mismatch".into()),
                DecisionScope::Global,
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }
    if context.content_hash != financial_snapshot.content_hash {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("content_hash_mismatch".into()),
                DecisionScope::Global,
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }

    let valid_decision_window = valid_context_time(&context)
        .zip(parse_rfc3339(&valid_until))
        .zip(parse_rfc3339(&context.horizon.ends_at))
        .is_some_and(|((evaluated_at, valid_until), horizon_end)| {
            evaluated_at < valid_until && valid_until <= horizon_end
        });
    if !valid_decision_window {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("invalid_decision_validity".into()),
                DecisionScope::Global,
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }

    if proposed_transaction.account_id.trim().is_empty()
        || category_id.trim().is_empty()
        || proposed_transaction.category_id.as_deref() != Some(category_id.as_str())
        || proposed_transaction.amount.minor_units() >= 0
    {
        let scope = if proposed_transaction.id.trim().is_empty() {
            DecisionScope::Global
        } else {
            DecisionScope::Transaction(proposed_transaction.id.clone())
        };
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("invalid_purchase_input".into()),
                scope,
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }

    let legacy_snapshot = &financial_snapshot.legacy_snapshot;
    let category_exists = legacy_snapshot
        .categories
        .iter()
        .any(|category| category.id == category_id && !category.deleted);
    if !category_exists {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("missing_required_identity".into()),
                DecisionScope::Category(category_id.clone()),
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }

    let account = legacy_snapshot
        .accounts
        .iter()
        .find(|account| account.id == proposed_transaction.account_id);
    if account.is_none() {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("missing_required_identity".into()),
                DecisionScope::Account(proposed_transaction.account_id.clone()),
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }

    let budget_category = legacy_snapshot
        .budgets
        .iter()
        .filter(|budget| {
            budget.month.as_str()
                <= legacy_snapshot
                    .snapshot_date
                    .get(..7)
                    .unwrap_or(legacy_snapshot.snapshot_date.as_str())
        })
        .max_by(|left, right| left.month.cmp(&right.month))
        .and_then(|budget| budget.categories.get(&category_id));
    let has_budget_category = budget_category.is_some();
    if !has_budget_category {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("missing_required_money".into()),
                DecisionScope::Category(category_id.clone()),
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }

    let expected_currency = budget_category.map(|budget| budget.amount.currency().to_owned());
    let account_allowed_by_policy = |account_id: &str| {
        context
            .policy
            .account_overrides
            .include_only
            .as_ref()
            .is_none_or(|included| included.iter().any(|id| id == account_id))
            && !context
                .policy
                .account_overrides
                .exclude
                .iter()
                .any(|id| id == account_id)
    };
    let incompatible_currency = expected_currency.as_deref().is_some_and(|currency| {
        proposed_transaction.amount.currency() != currency
            || account.is_some_and(|account| {
                account_allowed_by_policy(&account.id)
                    && account.cleared_balance.currency() != currency
            })
            || claims.iter().any(|claim| {
                claim_evaluation
                    .eligible_claim_ids
                    .contains(&claim.claim_id)
                    && matches!(&claim.scope, DecisionScope::Category(id) if id == &category_id)
                    && claim.amount.currency() != currency
            })
    });
    if incompatible_currency {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::CurrencyMismatch,
                DecisionScope::Category(category_id.clone()),
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }
    append_relevant_observation_issues(
        &financial_snapshot,
        &proposed_transaction,
        &category_id,
        &mut issues,
    );

    let mut evidence = Vec::new();
    for evidence_reference in financial_snapshot
        .observations
        .iter()
        .filter(|observation| {
            observation_supports_selected_evidence(observation, &proposed_transaction, &category_id)
        })
        .flat_map(|observation| observation.evidence.iter())
        .filter(|evidence_reference| {
            evidence_reference.authorized && evidence_reference.redaction == RedactionState::Visible
        })
    {
        if !evidence.iter().any(|existing: &EvidenceReference| {
            existing.evidence_id == evidence_reference.evidence_id
        }) {
            evidence.push(evidence_reference.clone());
        }
    }
    for evidence_reference in issues
        .iter()
        .filter(|issue| issue.redaction == RedactionState::Visible)
        .flat_map(|issue| issue.evidence.iter())
        .filter(|evidence_reference| {
            evidence_reference.authorized && evidence_reference.redaction == RedactionState::Visible
        })
    {
        if !evidence
            .iter()
            .any(|existing| existing.evidence_id == evidence_reference.evidence_id)
        {
            evidence.push(evidence_reference.clone());
        }
    }

    let has_stale_snapshot = exceeds_max_age(
        &context.evaluated_at,
        Some(&financial_snapshot.captured_at),
        context.policy.max_budget_snapshot_age_minutes,
    );
    let has_stale_bank_sync = if context.policy.max_bank_sync_age_minutes.is_some() {
        exceeds_max_age(
            &context.evaluated_at,
            legacy_snapshot.bank_synced_at.as_deref(),
            context.policy.max_bank_sync_age_minutes,
        )
    } else {
        legacy_snapshot
            .bank_synced_at
            .as_deref()
            .is_some_and(|synced| {
                synced
                    .get(..10)
                    .is_none_or(|date| date < legacy_snapshot.snapshot_date.get(..10).unwrap_or(""))
            })
    };
    let payload = evaluate_purchase_with_policy(
        PurchaseEvaluationRequest {
            snapshot: financial_snapshot.legacy_snapshot,
            proposed_transaction: proposed_transaction.clone(),
            category_id: category_id.clone(),
        },
        &context.policy,
        has_stale_snapshot,
        has_stale_bank_sync,
    );
    let payload_currency_compatible = expected_currency.as_deref().is_some_and(|currency| {
        payload.category_budget.currency() == currency
            && payload.category_spent.currency() == currency
            && payload.category_remaining.currency() == currency
            && payload
                .projected_balance
                .as_ref()
                .is_none_or(|balance| balance.currency() == currency)
    });
    if has_budget_category && !payload_currency_compatible {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::CurrencyMismatch,
                DecisionScope::Category(category_id.clone()),
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }
    if payload
        .reason_codes
        .iter()
        .any(|code| code == "currency_mismatch")
    {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::CurrencyMismatch,
                DecisionScope::Category(category_id.clone()),
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }
    if payload
        .reason_codes
        .iter()
        .any(|code| code == "stale_snapshot")
    {
        let mut issue = blocking_issue(
            DecisionIssueCode::AccountFreshnessCoverage,
            DecisionScope::Global,
            RedactionState::Visible,
            Vec::new(),
        );
        issue.remediation = Some(Remediation {
            code: "refresh_snapshot".into(),
            action: "Refresh the financial snapshot before evaluating again.".into(),
        });
        push_issue_once(&mut issues, issue);
    }
    if payload
        .reason_codes
        .iter()
        .any(|code| code == "account_unavailable")
    {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("account_unavailable".into()),
                DecisionScope::Account(proposed_transaction.account_id.clone()),
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }
    if payload
        .reason_codes
        .iter()
        .any(|code| code == "stale_bank_sync")
    {
        let mut issue = blocking_issue(
            DecisionIssueCode::AccountFreshnessCoverage,
            DecisionScope::Account(proposed_transaction.account_id.clone()),
            RedactionState::Visible,
            Vec::new(),
        );
        issue.remediation = Some(Remediation {
            code: "refresh_account_evidence".into(),
            action: "Refresh the affected account before evaluating again.".into(),
        });
        push_issue_once(&mut issues, issue);
    }
    if payload
        .reason_codes
        .iter()
        .any(|code| code == "evaluation_error")
    {
        push_issue_once(
            &mut issues,
            blocking_issue(
                DecisionIssueCode::Unknown("purchase_evaluation_error".into()),
                DecisionScope::Transaction(proposed_transaction.id.clone()),
                RedactionState::Visible,
                Vec::new(),
            ),
        );
    }

    let semantic_currency_compatible = payload_currency_compatible
        && !issues
            .iter()
            .any(|issue| issue.code == DecisionIssueCode::CurrencyMismatch);
    let mut before_amount =
        semantic_currency_compatible.then(|| payload.category_remaining.clone());
    for claim in claims.iter().filter(|claim| {
        claim_evaluation
            .eligible_claim_ids
            .contains(&claim.claim_id)
            && matches!(&claim.scope, DecisionScope::Category(id) if id == &category_id)
    }) {
        before_amount = before_amount.and_then(|amount| match amount.sub(&claim.amount) {
            Ok(remaining) => Some(remaining),
            Err(_) => {
                push_issue_once(
                    &mut issues,
                    blocking_issue(
                        if amount.currency() == claim.amount.currency() {
                            DecisionIssueCode::Unknown("money_arithmetic_overflow".into())
                        } else {
                            DecisionIssueCode::CurrencyMismatch
                        },
                        DecisionScope::Category(category_id.clone()),
                        RedactionState::Visible,
                        Vec::new(),
                    ),
                );
                None
            }
        });
    }

    let after_amount = before_amount.as_ref().and_then(|before| {
        let purchase_minor_units = proposed_transaction.amount.minor_units().checked_abs()?;
        let purchase = Money::new(
            purchase_minor_units,
            proposed_transaction.amount.currency().to_owned(),
        );
        match before.sub(&purchase) {
            Ok(after) => Some(after),
            Err(_) => {
                push_issue_once(
                    &mut issues,
                    blocking_issue(
                        if before.currency() == purchase.currency() {
                            DecisionIssueCode::Unknown("money_arithmetic_overflow".into())
                        } else {
                            DecisionIssueCode::CurrencyMismatch
                        },
                        DecisionScope::Category(category_id.clone()),
                        RedactionState::Visible,
                        Vec::new(),
                    ),
                );
                None
            }
        }
    });

    for issue in &mut issues {
        if issue.code == DecisionIssueCode::CurrencyMismatch {
            issue.remediation = Some(Remediation {
                code: "use_compatible_currency".into(),
                action: "Use an account and category with the purchase currency.".into(),
            });
        }
    }

    let readiness = if issues
        .iter()
        .any(|issue| issue.effect == DecisionIssueEffect::Blocks)
    {
        DecisionReadiness::Blocked
    } else if issues
        .iter()
        .any(|issue| issue.effect == DecisionIssueEffect::Qualifies)
    {
        DecisionReadiness::Qualified
    } else {
        DecisionReadiness::Ready
    };

    ProspectiveDecisionEnvelope {
        metadata: ProspectiveDecisionMetadata {
            contract_version: "1.0".into(),
            decision_id,
            decision_kind: "purchase".into(),
            request_id,
            correlation_id,
            context,
        },
        readiness,
        before: semantic_category_state(&category_id, before_amount),
        after: semantic_category_state(&category_id, after_amount),
        issues,
        evidence,
        alternatives: Vec::new(),
        expires_at: valid_until,
        redaction,
        payload,
    }
}

fn append_relevant_observation_issues(
    snapshot: &FinancialSnapshot,
    proposed_transaction: &Transaction,
    category_id: &str,
    issues: &mut Vec<DecisionIssue>,
) {
    for observation in snapshot.observations.iter().filter(|observation| {
        observation_is_relevant(observation, snapshot, proposed_transaction, category_id)
    }) {
        let (code, severity, effect, remediation) = match (observation.kind, observation.state) {
            (ObservationKind::AccountFreshness, ObservationState::Stale) => (
                DecisionIssueCode::AccountFreshnessCoverage,
                DecisionIssueSeverity::Warning,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "refresh_account_evidence".into(),
                    action: "Refresh the affected account before evaluating again.".into(),
                },
            ),
            (
                ObservationKind::AccountFreshness | ObservationKind::AccountCoverage,
                ObservationState::Unavailable,
            ) => (
                DecisionIssueCode::AccountFreshnessCoverage,
                DecisionIssueSeverity::Critical,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "reconnect_source".into(),
                    action: "Reconnect or refresh the affected source before evaluating again."
                        .into(),
                },
            ),
            (ObservationKind::AccountType, ObservationState::Unavailable) => (
                DecisionIssueCode::AccountFreshnessCoverage,
                DecisionIssueSeverity::Warning,
                DecisionIssueEffect::Qualifies,
                Remediation {
                    code: "reconnect_source".into(),
                    action: "Reconnect or refresh the affected source before evaluating again."
                        .into(),
                },
            ),
            (ObservationKind::AccountBalance, ObservationState::Unavailable) => (
                DecisionIssueCode::AccountFreshnessCoverage,
                DecisionIssueSeverity::Critical,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "reconnect_source".into(),
                    action: "Reconnect or refresh the affected source before evaluating again."
                        .into(),
                },
            ),
            (ObservationKind::ScheduleCoverage, ObservationState::Unavailable) => (
                DecisionIssueCode::ScheduleCoverage,
                DecisionIssueSeverity::Critical,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "reconnect_source".into(),
                    action: "Reconnect or refresh the affected source before evaluating again."
                        .into(),
                },
            ),
            (ObservationKind::CreditCardObligationCoverage, ObservationState::Unavailable) => (
                DecisionIssueCode::CreditPaymentUncertainty,
                DecisionIssueSeverity::Critical,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "reconnect_source".into(),
                    action: "Reconnect or refresh the affected source before evaluating again."
                        .into(),
                },
            ),
            (ObservationKind::TransferAmbiguity, ObservationState::Ambiguous) => (
                DecisionIssueCode::DuplicateTransferAmbiguity,
                DecisionIssueSeverity::Warning,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "review_transfer".into(),
                    action: "Review the related transactions and resolve the transfer ambiguity."
                        .into(),
                },
            ),
            (ObservationKind::DuplicateCandidate, ObservationState::Present) => (
                DecisionIssueCode::DuplicateTransferAmbiguity,
                DecisionIssueSeverity::Warning,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "review_transfer".into(),
                    action: "Review the related transactions and resolve the transfer ambiguity."
                        .into(),
                },
            ),
            (ObservationKind::DuplicateCandidate, ObservationState::Ambiguous) => (
                DecisionIssueCode::EconomicEventAmbiguity,
                DecisionIssueSeverity::Warning,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "review_duplicate".into(),
                    action: "Review the related transactions and resolve the duplicate candidate."
                        .into(),
                },
            ),
            (ObservationKind::PendingActivity, ObservationState::Unavailable) => (
                DecisionIssueCode::PendingAvailability,
                DecisionIssueSeverity::Warning,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "refresh_account_evidence".into(),
                    action: "Refresh the affected account before evaluating again.".into(),
                },
            ),
            (ObservationKind::CurrencyCompatibility, ObservationState::Incompatible) => (
                DecisionIssueCode::CurrencyMismatch,
                DecisionIssueSeverity::Critical,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "use_compatible_currency".into(),
                    action: "Use an account and category with the purchase currency.".into(),
                },
            ),
            (ObservationKind::Reconciliation, ObservationState::Unreconciled) => (
                DecisionIssueCode::EconomicEventAmbiguity,
                DecisionIssueSeverity::Warning,
                DecisionIssueEffect::Blocks,
                Remediation {
                    code: "review_material_evidence".into(),
                    action: "Review the supporting evidence before evaluating again.".into(),
                },
            ),
            _ => continue,
        };
        let evidence = observation
            .evidence
            .iter()
            .filter(|reference| {
                reference.authorized && reference.redaction == RedactionState::Visible
            })
            .cloned()
            .collect();
        push_issue_once(
            issues,
            DecisionIssue {
                code,
                severity,
                effect,
                scope: observation.scope.clone(),
                evidence,
                remediation: Some(remediation),
                redaction: RedactionState::Visible,
            },
        );
    }
}

fn observation_is_relevant(
    observation: &SourceObservation,
    snapshot: &FinancialSnapshot,
    proposed_transaction: &Transaction,
    category_id: &str,
) -> bool {
    match &observation.scope {
        DecisionScope::Global => true,
        DecisionScope::Account(id) => id == &proposed_transaction.account_id,
        DecisionScope::Category(id) => id == category_id,
        DecisionScope::Transaction(id) => {
            id == &proposed_transaction.id
                || snapshot
                    .legacy_snapshot
                    .transactions
                    .iter()
                    .any(|transaction| {
                        transaction.id == *id
                            && (transaction.account_id == proposed_transaction.account_id
                                || transaction.category_id.as_deref() == Some(category_id))
                    })
        }
        DecisionScope::Schedule(id) => snapshot
            .legacy_snapshot
            .schedules
            .iter()
            .any(|schedule| schedule.id == *id),
        DecisionScope::Claim(_) => false,
    }
}

fn observation_supports_selected_evidence(
    observation: &SourceObservation,
    proposed_transaction: &Transaction,
    category_id: &str,
) -> bool {
    if observation.state == ObservationState::Unknown {
        return false;
    }

    match &observation.scope {
        DecisionScope::Account(id) => {
            id == &proposed_transaction.account_id
                && matches!(
                    observation.kind,
                    ObservationKind::AccountFreshness
                        | ObservationKind::AccountCoverage
                        | ObservationKind::AccountType
                        | ObservationKind::AccountBalance
                )
        }
        DecisionScope::Category(id) => id == category_id,
        DecisionScope::Transaction(id) => id == &proposed_transaction.id,
        DecisionScope::Global | DecisionScope::Schedule(_) | DecisionScope::Claim(_) => false,
    }
}

fn exceeds_max_age(
    evaluated_at: &str,
    observed_at: Option<&str>,
    max_age_minutes: Option<u64>,
) -> bool {
    let Some(max_age_minutes) = max_age_minutes else {
        return false;
    };
    let Some(evaluated_at) = parse_rfc3339(evaluated_at) else {
        return true;
    };
    let Some(observed_at) = observed_at.and_then(parse_rfc3339) else {
        return true;
    };
    let evaluated_nanoseconds =
        i128::from(evaluated_at.seconds) * 1_000_000_000 + i128::from(evaluated_at.nanoseconds);
    let observed_nanoseconds =
        i128::from(observed_at.seconds) * 1_000_000_000 + i128::from(observed_at.nanoseconds);
    let max_age_nanoseconds = i128::from(max_age_minutes) * 60 * 1_000_000_000;
    evaluated_nanoseconds - observed_nanoseconds > max_age_nanoseconds
}

fn semantic_category_state(category_id: &str, amount: Option<Money>) -> DecisionSemanticState {
    DecisionSemanticState {
        amounts: amount
            .map(|amount| DecisionAmount {
                label: FinancialStateLabel::EnvelopeAvailability,
                scope: DecisionScope::Category(category_id.to_owned()),
                amount,
            })
            .into_iter()
            .collect(),
    }
}

fn valid_context_time(context: &DecisionContext) -> Option<ParsedTimestamp> {
    if context.policy_version.is_empty()
        || context.policy_hash.is_empty()
        || context.snapshot_id.is_empty()
        || context.content_hash.is_empty()
    {
        return None;
    }
    let evaluated_at = parse_rfc3339(&context.evaluated_at)?;
    let starts_at = parse_rfc3339(&context.horizon.starts_at)?;
    let ends_at = parse_rfc3339(&context.horizon.ends_at)?;
    (starts_at <= evaluated_at && evaluated_at < ends_at).then_some(evaluated_at)
}

fn valid_claim_identity(claim: &ProspectiveClaim) -> bool {
    if claim.claim_id.is_empty() || claim.source_id.is_empty() {
        return false;
    }
    match &claim.scope {
        DecisionScope::Global => true,
        DecisionScope::Account(id)
        | DecisionScope::Category(id)
        | DecisionScope::Transaction(id)
        | DecisionScope::Schedule(id)
        | DecisionScope::Claim(id) => !id.is_empty(),
    }
}

fn claim_scope_allowed_by_policy(context: &DecisionContext, claim: &ProspectiveClaim) -> bool {
    let DecisionScope::Account(account_id) = &claim.scope else {
        return true;
    };
    context
        .policy
        .account_overrides
        .include_only
        .as_ref()
        .is_none_or(|included| included.iter().any(|id| id == account_id))
        && !context
            .policy
            .account_overrides
            .exclude
            .iter()
            .any(|id| id == account_id)
}

fn duplicate_claim_ids(context: &DecisionContext, claims: &[ProspectiveClaim]) -> Vec<String> {
    let mut duplicates = Vec::new();
    for (index, claim) in claims.iter().enumerate() {
        if !claim_scope_allowed_by_policy(context, claim) {
            continue;
        }
        if claims[index + 1..].iter().any(|other| {
            claim_scope_allowed_by_policy(context, other) && other.claim_id == claim.claim_id
        }) && !duplicates.contains(&claim.claim_id)
        {
            duplicates.push(claim.claim_id.clone());
        }
    }
    duplicates
}

fn claim_input_issue(code: &str, claim: &ProspectiveClaim) -> DecisionIssue {
    let redaction = claim.visibility;
    let scope = if redaction == RedactionState::Redacted {
        DecisionScope::Global
    } else {
        DecisionScope::Claim(claim.claim_id.clone())
    };
    blocking_issue(
        DecisionIssueCode::Unknown(code.into()),
        scope,
        redaction,
        evidence_for_claims(std::iter::once(claim), redaction),
    )
}

fn report_scope_conflicts(eligible: &[&ProspectiveClaim], issues: &mut Vec<DecisionIssue>) {
    let mut reported_scopes: Vec<&DecisionScope> = Vec::new();
    for claim in eligible {
        if reported_scopes.contains(&&claim.scope) {
            continue;
        }
        let scoped_claims: Vec<_> = eligible
            .iter()
            .copied()
            .filter(|other| other.scope == claim.scope)
            .collect();
        if scoped_claims.len() < 2 {
            continue;
        }
        reported_scopes.push(&claim.scope);
        let redaction = combined_redaction(scoped_claims.iter().copied());
        push_issue_once(
            issues,
            blocking_issue(
                DecisionIssueCode::ReservationConflict,
                claim.scope.clone(),
                redaction,
                evidence_for_claims(scoped_claims.iter().copied(), redaction),
            ),
        );

        let first_currency = scoped_claims[0].amount.currency();
        if scoped_claims
            .iter()
            .skip(1)
            .any(|other| other.amount.currency() != first_currency)
        {
            let redaction = combined_redaction(scoped_claims.iter().copied());
            push_issue_once(
                issues,
                blocking_issue(
                    DecisionIssueCode::CurrencyMismatch,
                    claim.scope.clone(),
                    redaction,
                    evidence_for_claims(scoped_claims.iter().copied(), redaction),
                ),
            );
        }
    }
}

fn aggregate_kind(
    kind: ProspectiveClaimKind,
    eligible: &[&ProspectiveClaim],
    issues: &mut Vec<DecisionIssue>,
) -> Option<Money> {
    let mut matching = eligible.iter().copied().filter(|claim| claim.kind == kind);
    let first = matching.next()?;
    let mut total = first.amount.clone();

    for claim in matching {
        if claim.amount.currency() != total.currency() {
            let redaction = combined_redaction([first, claim]);
            push_issue_once(
                issues,
                blocking_issue(
                    DecisionIssueCode::CurrencyMismatch,
                    claim.scope.clone(),
                    redaction,
                    evidence_for_claims([first, claim], redaction),
                ),
            );
            return None;
        }
        match total.add(&claim.amount) {
            Ok(sum) => total = sum,
            Err(_) => {
                let redaction = combined_redaction([first, claim]);
                push_issue_once(
                    issues,
                    blocking_issue(
                        DecisionIssueCode::Unknown("money_arithmetic_overflow".into()),
                        claim.scope.clone(),
                        redaction,
                        evidence_for_claims([first, claim], redaction),
                    ),
                );
                return None;
            }
        }
    }
    Some(total)
}

fn combined_redaction<'a>(
    claims: impl IntoIterator<Item = &'a ProspectiveClaim>,
) -> RedactionState {
    if claims
        .into_iter()
        .any(|claim| claim.visibility == RedactionState::Redacted)
    {
        RedactionState::Redacted
    } else {
        RedactionState::Visible
    }
}

fn evidence_for_claims<'a>(
    claims: impl IntoIterator<Item = &'a ProspectiveClaim>,
    redaction: RedactionState,
) -> Vec<EvidenceReference> {
    if redaction == RedactionState::Redacted {
        return Vec::new();
    }
    claims
        .into_iter()
        .map(|claim| EvidenceReference {
            evidence_id: claim.source_id.clone(),
            kind: "prospective_claim".into(),
            authorized: true,
            redaction: RedactionState::Visible,
        })
        .collect()
}

fn blocking_issue(
    code: DecisionIssueCode,
    scope: DecisionScope,
    redaction: RedactionState,
    evidence: Vec<EvidenceReference>,
) -> DecisionIssue {
    DecisionIssue {
        code,
        severity: DecisionIssueSeverity::Critical,
        effect: DecisionIssueEffect::Blocks,
        scope,
        evidence,
        remediation: None,
        redaction,
    }
}

fn push_issue_once(issues: &mut Vec<DecisionIssue>, issue: DecisionIssue) {
    if !issues
        .iter()
        .any(|existing| existing.code == issue.code && existing.scope == issue.scope)
    {
        issues.push(issue);
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
struct ParsedTimestamp {
    seconds: i64,
    nanoseconds: u32,
}

fn parse_rfc3339(value: &str) -> Option<ParsedTimestamp> {
    let bytes = value.as_bytes();
    if bytes.len() < 20
        || bytes.get(4) != Some(&b'-')
        || bytes.get(7) != Some(&b'-')
        || bytes.get(10) != Some(&b'T')
        || bytes.get(13) != Some(&b':')
        || bytes.get(16) != Some(&b':')
    {
        return None;
    }

    let year = parse_digits(bytes, 0, 4)? as i64;
    let month = parse_digits(bytes, 5, 2)?;
    let day = parse_digits(bytes, 8, 2)?;
    let hour = parse_digits(bytes, 11, 2)?;
    let minute = parse_digits(bytes, 14, 2)?;
    let second = parse_digits(bytes, 17, 2)?;
    if !(1..=12).contains(&month)
        || day == 0
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return None;
    }

    let mut position = 19;
    let mut nanoseconds = 0_u32;
    if bytes.get(position) == Some(&b'.') {
        position += 1;
        let fraction_start = position;
        while bytes.get(position).is_some_and(u8::is_ascii_digit) {
            position += 1;
        }
        let digits = position.checked_sub(fraction_start)?;
        if digits == 0 || digits > 9 {
            return None;
        }
        nanoseconds = parse_digits(bytes, fraction_start, digits)?;
        for _ in digits..9 {
            nanoseconds = nanoseconds.checked_mul(10)?;
        }
    }

    let offset_seconds = match bytes.get(position) {
        Some(b'Z') if position + 1 == bytes.len() => 0_i64,
        Some(sign @ (b'+' | b'-')) if position + 6 == bytes.len() => {
            if bytes.get(position + 3) != Some(&b':') {
                return None;
            }
            let offset_hour = parse_digits(bytes, position + 1, 2)?;
            let offset_minute = parse_digits(bytes, position + 4, 2)?;
            if offset_hour > 23 || offset_minute > 59 {
                return None;
            }
            let magnitude = i64::from(offset_hour) * 3_600 + i64::from(offset_minute) * 60;
            if *sign == b'+' {
                magnitude
            } else {
                -magnitude
            }
        }
        _ => return None,
    };

    let days = days_from_civil(year, month, day);
    let local_seconds = days
        .checked_mul(86_400)?
        .checked_add(i64::from(hour) * 3_600)?
        .checked_add(i64::from(minute) * 60)?
        .checked_add(i64::from(second))?;
    Some(ParsedTimestamp {
        seconds: local_seconds.checked_sub(offset_seconds)?,
        nanoseconds,
    })
}

fn parse_digits(bytes: &[u8], start: usize, len: usize) -> Option<u32> {
    let mut value = 0_u32;
    for byte in bytes.get(start..start.checked_add(len)?)? {
        if !byte.is_ascii_digit() {
            return None;
        }
        value = value.checked_mul(10)?.checked_add(u32::from(byte - b'0'))?;
    }
    Some(value)
}

fn days_in_month(year: i64, month: u32) -> u32 {
    match month {
        2 if year % 4 == 0 && (year % 100 != 0 || year % 400 == 0) => 29,
        2 => 28,
        4 | 6 | 9 | 11 => 30,
        _ => 31,
    }
}

fn days_from_civil(year: i64, month: u32, day: u32) -> i64 {
    let adjusted_year = year - i64::from(month <= 2);
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let shifted_month = i64::from(month) + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * shifted_month + 2) / 5 + i64::from(day) - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}
