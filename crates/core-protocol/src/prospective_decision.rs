//! Immutable inputs and typed results for prospective financial decisions.

use balanceframe_financial_core::{
    DecisionDataPolicy, DecisionIssue, DecisionIssueCode, DecisionIssueEffect,
    DecisionIssueSeverity, DecisionScope, EvidenceReference, FinancialStateLabel, Money,
    RedactionState,
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

    let duplicate_ids = duplicate_claim_ids(claims);
    for claim_id in &duplicate_ids {
        let duplicate_claims: Vec<_> = claims
            .iter()
            .filter(|claim| &claim.claim_id == claim_id)
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
            && expires_at.map_or(true, |expires_at| evaluated_at < expires_at)
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

fn duplicate_claim_ids(claims: &[ProspectiveClaim]) -> Vec<String> {
    let mut duplicates = Vec::new();
    for (index, claim) in claims.iter().enumerate() {
        if claims[index + 1..]
            .iter()
            .any(|other| other.claim_id == claim.claim_id)
            && !duplicates.contains(&claim.claim_id)
        {
            duplicates.push(claim.claim_id.clone());
        }
    }
    duplicates
}

fn claim_input_issue(code: &str, claim: &ProspectiveClaim) -> DecisionIssue {
    let redaction = claim.visibility.clone();
    let scope = if redaction == RedactionState::Redacted {
        DecisionScope::Global
    } else {
        DecisionScope::Claim(claim.claim_id.clone())
    };
    blocking_issue(
        DecisionIssueCode::Unknown(code.into()),
        scope,
        redaction.clone(),
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
                redaction.clone(),
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
                    redaction.clone(),
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
            let redaction = combined_redaction([first, claim].into_iter());
            push_issue_once(
                issues,
                blocking_issue(
                    DecisionIssueCode::CurrencyMismatch,
                    claim.scope.clone(),
                    redaction.clone(),
                    evidence_for_claims([first, claim].into_iter(), redaction),
                ),
            );
            return None;
        }
        match total.add(&claim.amount) {
            Ok(sum) => total = sum,
            Err(_) => {
                let redaction = combined_redaction([first, claim].into_iter());
                push_issue_once(
                    issues,
                    blocking_issue(
                        DecisionIssueCode::Unknown("money_arithmetic_overflow".into()),
                        claim.scope.clone(),
                        redaction.clone(),
                        evidence_for_claims([first, claim].into_iter(), redaction),
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
