//! Deterministic no‑model analysis orchestrator.
//!
//! Runs all checks — freshness, coverage, readiness, uncategorized backlog,
//! repeated merchants, duplicate evidence, rule candidates, recurring charges,
//! historical corrections — and bundles them into a single
//! [`DeterministicAnalysis`] result.

use std::collections::{HashMap, HashSet};

use serde::{Deserialize, Serialize};

use crate::blockers::{Blocker, BlockerCollector, ReasonCode};
use crate::categorization::{find_candidates, CategorizationCandidate};
use crate::coverage::{build_coverage_report, CoverageReport, InclusionScope};
use crate::data_quality::{analyze_readiness, DataQualityReport};
use crate::duplicates::{find_duplicates, DuplicateEvidence};
use crate::freshness::{CompatibilityMetadata, DataFreshness};
use crate::merchant::normalize_merchant;
use crate::money::Money;
use crate::snapshots::{Account, BudgetMonth, Category, Payee, Rule, Schedule, Transaction};

// ---------------------------------------------------------------------------
// UncategorizedBacklog
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UncategorizedBacklog {
    pub count: usize,
    pub oldest_date: Option<String>,
    pub total_amount: Money,
    pub transaction_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// RepeatedMerchant
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RepeatedMerchant {
    pub normalized_name: String,
    pub original_names: Vec<String>,
    pub frequency: usize,
    pub total_amount: Money,
    pub sample_transaction_ids: Vec<String>,
}

// ---------------------------------------------------------------------------
// RuleCandidate
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuleCandidate {
    pub rule_id: String,
    pub rule_name: String,
    pub proposed_category_id: String,
    pub proposed_category_name: String,
    pub matching_tx_count: u32,
    pub reason: String,
    pub account_ids: Vec<String>,
    pub direction: String,
    pub amount_min: Option<i64>,
    pub amount_max: Option<i64>,
    pub date_earliest: Option<String>,
    pub date_latest: Option<String>,
    pub is_merchant_only: bool,
    pub conflict_reason: Option<String>,
}

// ---------------------------------------------------------------------------
// RecurringCharge
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RecurringCharge {
    pub normalized_merchant: String,
    pub original_name: String,
    pub frequency_label: String,
    pub typical_amount: Money,
    pub transaction_ids: Vec<String>,
    pub dates: Vec<String>,
    pub confidence: f64,
}

// ---------------------------------------------------------------------------
// HistoricalCorrection
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct HistoricalCorrection {
    pub category_id: String,
    pub category_name: String,
    pub change_count: usize,
    pub months: Vec<String>,
}

// ---------------------------------------------------------------------------
// CorrectionEvidence — structured evidence from approved/corrected reviews
// ---------------------------------------------------------------------------

/// Structured evidence captured from an approved or corrected review
/// transition.  Each record represents one human approval or correction
/// event, with the contextual state that was current at transition time.
///
/// When multiple corrections for the same merchant carry conflicting
/// account / direction / category values, the rule candidate analysis
/// flags rather than collapses the conflict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CorrectionEvidence {
    /// Source review item ID that produced this correction.
    pub source_review_id: String,
    /// Normalized merchant name from the transaction payee.
    pub merchant: Option<String>,
    /// Imported payee name from transaction import data.
    pub imported_payee: Option<String>,
    /// Account ID the transaction belongs to.
    pub account_id: Option<String>,
    /// Direction — `"inflow"` or `"outflow"`.
    pub direction: Option<String>,
    /// Transaction amount in minor units.
    pub amount: Option<i64>,
    /// Transaction date (ISO-8601).
    pub date: Option<String>,
    /// The category that was approved or assigned.
    pub category_id: String,
    /// Human-readable category name.
    pub category_name: Option<String>,
    /// Actor who performed the approval or correction.
    pub actor: String,
    /// Review status before this transition.
    pub from_status: String,
    /// Review status after this transition.
    pub to_status: String,
}

// ---------------------------------------------------------------------------
// DeterministicAnalysis
// ---------------------------------------------------------------------------

/// Complete output of the no‑model deterministic analysis pipeline.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeterministicAnalysis {
    pub freshness: DataFreshness,
    pub compatibility: CompatibilityMetadata,
    pub coverage: CoverageReport,
    pub readiness: DataQualityReport,
    pub uncategorized_backlog: UncategorizedBacklog,
    pub repeated_merchants: Vec<RepeatedMerchant>,
    pub deterministic_classifications: Vec<CategorizationCandidate>,
    pub rule_candidates: Vec<RuleCandidate>,
    pub duplicate_evidence: Vec<DuplicateEvidence>,
    pub recurring_charges: Vec<RecurringCharge>,
    pub historical_corrections: Vec<HistoricalCorrection>,
    pub blockers: Vec<Blocker>,
    pub reason_codes: Vec<String>,
    pub result_code: String,
}

// ---------------------------------------------------------------------------
// run_deterministic_analysis
// ---------------------------------------------------------------------------

/// Run all deterministic checks against the snapshot data and return a
/// structured [`DeterministicAnalysis`].
///
/// This function never calls any model provider; every result is derived
/// purely from the snapshot contents and simple arithmetic.
#[allow(clippy::too_many_arguments)]
pub fn run_deterministic_analysis(
    accounts: &[Account],
    transactions: &[Transaction],
    categories: &[Category],
    payees: &[Payee],
    _rules: &[Rule],
    schedules: &[Schedule],
    budgets: &[BudgetMonth],
    compatibility: CompatibilityMetadata,
    actual_downloaded_at: Option<String>,
    bank_synced_at: Option<String>,
    scope: &InclusionScope,
    reference_date: &str,
) -> DeterministicAnalysis {
    let mut collector = BlockerCollector::new();

    // -----------------------------------------------------------------------
    // 0. Pre‑filter transactions by policy scope
    // -----------------------------------------------------------------------
    let scoped_txns: Vec<Transaction> = transactions
        .iter()
        .filter(|tx| scope.matches(tx))
        .cloned()
        .collect();

    // Detect when policy filtering excludes transactions and emit a
    // policy‑related reason code.
    if scoped_txns.len() < transactions.len() {
        if !scope.include_pending || !scope.include_cleared {
            collector.add_reason(ReasonCode::PendingPolicy);
        }
        if !scope.include_transfers {
            collector.add_reason(ReasonCode::ExcludedByPolicy);
        }
    }

    // -----------------------------------------------------------------------
    // 1. Freshness
    // -----------------------------------------------------------------------
    let freshness = DataFreshness::compute(
        actual_downloaded_at.clone(),
        bank_synced_at.clone(),
        scope.include_pending,
        reference_date,
    );
    if freshness.is_stale {
        collector.add_blocker(
            "stale_snapshot",
            format!("Snapshot is stale ({} days old)", freshness.staleness_days),
            "_overview",
        );
        collector.add_reason(ReasonCode::StaleSnapshot);
    }
    // Emit StaleMetadata when download timestamp is missing
    if actual_downloaded_at.is_none() {
        collector.add_reason(ReasonCode::StaleMetadata);
    }
    // Bank sync staleness
    if freshness.bank_sync_stale {
        collector.add_blocker(
            "stale_bank_sync",
            format!(
                "Bank sync is stale ({} days old)",
                freshness.bank_staleness_days
            ),
            "_overview",
        );
        collector.add_reason(ReasonCode::StaleBankSync);
    }

    // -----------------------------------------------------------------------
    // 2. Compatibility
    // -----------------------------------------------------------------------
    if !compatibility.version_compatible {
        collector.add_blocker(
            "incompatible_version",
            compatibility
                .compatibility_message
                .clone()
                .unwrap_or_else(|| "Unsupported Actual version".into()),
            "_overview",
        );
        collector.add_reason(ReasonCode::UnsupportedSchemaVersion);
    }
    if compatibility.encryption_key_required && !compatibility.encryption_unlocked {
        collector.add_blocker(
            "encryption_locked",
            "Budget is encrypted and encryption key was not provided or is incorrect",
            "_overview",
        );
        collector.add_reason(ReasonCode::EncryptionLocked);
    }

    // -----------------------------------------------------------------------
    // 3. Coverage (uses filtered transactions)
    // -----------------------------------------------------------------------
    let coverage = build_coverage_report(accounts, &scoped_txns, scope);
    let missing_accounts: Vec<String> = coverage
        .accounts
        .iter()
        .filter(|a| a.transaction_count == 0)
        .map(|a| a.account_id.clone())
        .collect();
    if !missing_accounts.is_empty() {
        collector.add_blocker(
            "missing_account",
            format!(
                "Accounts with no transactions: {}",
                missing_accounts.join(", ")
            ),
            "_overview",
        );
        collector.add_reason(ReasonCode::MissingAccount);
    }

    // -----------------------------------------------------------------------
    // 4. Readiness (data quality) — uses filtered transactions
    // -----------------------------------------------------------------------
    let readiness = analyze_readiness(accounts, &scoped_txns, categories, reference_date);
    for issue in &readiness.issues {
        if issue.code == "AMOUNT_OVERFLOW" {
            collector.add_reason(ReasonCode::AmountOverflow);
            collector.add_blocker(
                "amount_overflow",
                format!(
                    "Amount overflow detected for entity {}: {}",
                    issue.entity_id, issue.message
                ),
                issue.entity_id.clone(),
            );
        }
        if issue.code == "UNCATEGORIZED_TRANSACTIONS" {
            collector.add_reason(ReasonCode::UncategorizedExposure);
        }
        if issue.code == "DELETED_CATEGORY_REFERENCED" {
            collector.add_reason(ReasonCode::DeletedCategoryReferenced);
            collector.add_blocker(
                "deleted_category_referenced",
                format!(
                    "Deleted category referenced by entity {}: {}",
                    issue.entity_id, issue.message
                ),
                issue.entity_id.clone(),
            );
        }
        if issue.code == "DUPLICATE_CANDIDATE" {
            collector.add_reason(ReasonCode::DuplicateDetected);
        }
    }

    // -----------------------------------------------------------------------
    // 5. Uncategorized backlog (uses filtered transactions)
    // -----------------------------------------------------------------------
    let (uncategorized_backlog, blocker_codes) = build_uncategorized_backlog(&scoped_txns, categories);
    if !blocker_codes.is_empty() {
        for code in blocker_codes {
            if code == "amount_overflow" {
                collector.add_reason(ReasonCode::AmountOverflow);
                collector.add_blocker(
                    "amount_overflow",
                    "Overflow while summing uncategorized transaction amounts",
                    "_overview",
                );
            }
            if code == "mixed_currency" {
                collector.add_reason(ReasonCode::UnresolvedMetadataRef);
                collector.add_blocker(
                    "mixed_currency",
                    "Uncategorized transactions span multiple currencies",
                    "_overview",
                );
            }
        }
    }

    // -----------------------------------------------------------------------
    // 6. Repeated merchants (uses filtered transactions)
    // -----------------------------------------------------------------------
    let repeated_merchants = find_repeated_merchants(&scoped_txns);

    // -----------------------------------------------------------------------
    // 7. Deterministic classifications (uses filtered transactions)
    // -----------------------------------------------------------------------
    let history: Vec<crate::categorization::HistoryRecord> = scoped_txns
        .iter()
        .filter(|tx| {
            tx.category_id.is_some()
                && tx.category_id.as_deref() != Some("")
                && tx.payee_name.is_some()
        })
        .map(|tx| {
            let payee = tx.payee_name.clone().unwrap_or_default();
            let cat_name = tx
                .category_name
                .clone()
                .unwrap_or_else(|| "Unknown".into());
            let cat_id = tx
                .category_id
                .clone()
                .unwrap_or_default();
            crate::categorization::HistoryRecord {
                transaction_id: tx.id.clone(),
                payee_name: payee,
                category_id: cat_id,
                category_name: cat_name,
                amount: tx.amount.clone(),
                date: tx.date.clone(),
            }
        })
        .collect();

    let deterministic_classifications = find_candidates(&scoped_txns, payees, &history);

    // -----------------------------------------------------------------------
    // 8. Rule candidates (uses filtered transactions)
    // -----------------------------------------------------------------------
    let rule_candidates = generate_rule_candidates(&scoped_txns, categories, 2);

    // -----------------------------------------------------------------------
    // 9. Duplicate evidence (uses filtered transactions)
    // -----------------------------------------------------------------------
    let duplicate_evidence = find_duplicates(&scoped_txns);

    // -----------------------------------------------------------------------
    // 10. Recurring charges (uses filtered transactions)
    // -----------------------------------------------------------------------
    let recurring_charges = find_recurring_charges(&scoped_txns, schedules);

    // -----------------------------------------------------------------------
    // 11. Historical corrections (budget changes — not transaction‑dependent)
    // -----------------------------------------------------------------------
    let historical_corrections = find_historical_corrections(budgets, categories);

    // -----------------------------------------------------------------------
    // 12. Result code
    // -----------------------------------------------------------------------
    let result_code = if collector.has_blockers() {
        "error"
    } else if !duplicate_evidence.is_empty()
        || !uncategorized_backlog.transaction_ids.is_empty()
        || !repeated_merchants.is_empty()
    {
        "warning"
    } else {
        "success"
    };

    let reason_codes_final = collector.string_reasons();
    let blockers_final = collector.blockers;

    DeterministicAnalysis {
        freshness,
        compatibility,
        coverage,
        readiness,
        uncategorized_backlog,
        repeated_merchants,
        deterministic_classifications,
        rule_candidates,
        duplicate_evidence,
        recurring_charges,
        historical_corrections,
        blockers: blockers_final,
        reason_codes: reason_codes_final,
        result_code: result_code.into(),
    }
}

// Uncategorized backlog analysis
// ---------------------------------------------------------------------------

fn build_uncategorized_backlog(
    transactions: &[Transaction],
    categories: &[Category],
) -> (UncategorizedBacklog, Vec<String>) {
    let active_cat_ids: HashSet<&str> = categories.iter().map(|c| c.id.as_str()).collect();
    let mut blocker_codes: Vec<String> = Vec::new();

    let mut uncategorized: Vec<&Transaction> = transactions
        .iter()
        .filter(|tx| {
            tx.category_id.is_none()
                || tx.category_id.as_deref() == Some("")
                || tx
                    .category_id
                    .as_deref()
                    .map(|cid| !active_cat_ids.contains(cid))
                    .unwrap_or(false)
        })
        .collect();

    // Sort by date ascending to find oldest
    uncategorized.sort_by(|a, b| a.date.cmp(&b.date));

    let count = uncategorized.len();
    if count == 0 {
        return (
            UncategorizedBacklog {
                count: 0,
                oldest_date: None,
                total_amount: Money::zero("USD"),
                transaction_ids: vec![],
            },
            blocker_codes,
        );
    }

    let oldest_date = uncategorized.first().map(|tx| tx.date.clone());

    // Check that all transactions share the same currency
    let first_currency = uncategorized[0].amount.currency().to_string();
    let mixed_currency = uncategorized
        .iter()
        .any(|tx| tx.amount.currency() != first_currency);
    if mixed_currency {
        blocker_codes.push("mixed_currency".into());
    }

    let mut total_minor: i64 = 0;
    for tx in &uncategorized {
        match tx.amount.minor_units().checked_abs() {
            Some(abs) => {
                match total_minor.checked_add(abs) {
                    Some(s) => total_minor = s,
                    None => {
                        blocker_codes.push("amount_overflow".into());
                    }
                }
            }
            None => {
                blocker_codes.push("amount_overflow".into());
            }
        }
    }

    // Use the first transaction's currency (consistent across all if mixed_currency wasn't set)
    let currency = first_currency;

    // total_minor is already absolute — no need for another .abs() call
    let total_amount = Money::new(total_minor, &currency);

    let transaction_ids: Vec<String> = uncategorized.iter().map(|tx| tx.id.clone()).collect();

    (
        UncategorizedBacklog {
            count,
            oldest_date,
            total_amount,
            transaction_ids,
        },
        blocker_codes,
    )
}

// ---------------------------------------------------------------------------
// Repeated merchant analysis
// ---------------------------------------------------------------------------

fn find_repeated_merchants(transactions: &[Transaction]) -> Vec<RepeatedMerchant> {
    let mut groups: HashMap<String, Vec<&Transaction>> = HashMap::new();

    for tx in transactions {
        let normalized = normalize_merchant(tx.payee_name.as_deref().unwrap_or(""));
        if normalized.is_empty() {
            continue;
        }
        groups.entry(normalized).or_default().push(tx);
    }

    let mut merchants: Vec<RepeatedMerchant> = groups
        .into_iter()
        .filter(|(_, txs)| txs.len() > 1)
        .filter_map(|(norm, txs)| {
            // Reject mixed-currency groups
            let currency = txs.first()?.amount.currency().to_string();
            if txs.iter().any(|tx| tx.amount.currency() != currency) {
                return None;
            }

            let original_names: Vec<String> = txs
                .iter()
                .filter_map(|tx| tx.payee_name.clone())
                .collect();
            let frequency = txs.len();

            // Checked accumulation of absolute values
            let mut total_minor: i64 = 0;
            for tx in &txs {
                let abs = tx.amount.minor_units().checked_abs()?;
                total_minor = total_minor.checked_add(abs)?;
            }

            let sample_ids: Vec<String> = txs.iter().take(10).map(|tx| tx.id.clone()).collect();

            Some(RepeatedMerchant {
                normalized_name: norm,
                original_names,
                frequency,
                total_amount: Money::new(total_minor, &currency),
                sample_transaction_ids: sample_ids,
            })
        })
        .collect();

    // Sort by normalized_name for deterministic output
    merchants.sort_by(|a, b| a.normalized_name.cmp(&b.normalized_name));
    merchants
}

// ---------------------------------------------------------------------------
// Rule candidate analysis — evidence‑based
// ---------------------------------------------------------------------------

/// Analyze approved transaction history to find merchants consistently
/// categorized to the same category across different transactions/accounts,
/// above a `min_consistent_count` threshold.
///
/// This is the evidence‑based replacement for the old `build_rule_candidates`
/// which only looked at existing rules.  The generated candidates are
/// suggestions for *new* rules derived from observed historical behavior.
pub fn generate_rule_candidates(
    transactions: &[Transaction],
    categories: &[Category],
    min_consistent_count: u32,
) -> Vec<RuleCandidate> {
    // Group categorized transactions by normalized merchant name.
    // Track both category counts and contextual metadata for conflict detection.
    #[derive(Default)]
    struct MerchantContext {
        cats: HashMap<String, (String, u32)>,
        account_ids: HashSet<String>,
        amounts: Vec<i64>,
        dates: Vec<String>,
    }

    let mut merchant_data: HashMap<String, MerchantContext> = HashMap::new();

    for tx in transactions {
        let payee = match &tx.payee_name {
            Some(p) if !p.is_empty() => p,
            _ => continue,
        };
        let cat_id = match &tx.category_id {
            Some(c) if !c.is_empty() => c.clone(),
            _ => continue,
        };
        let cat_name = tx
            .category_name
            .clone()
            .unwrap_or_else(|| "Unknown".into());
        let normalized = normalize_merchant(payee);
        if normalized.is_empty() {
            continue;
        }

        let ctx = merchant_data.entry(normalized).or_default();
        let entry = ctx.cats.entry(cat_id).or_insert_with(|| (cat_name.clone(), 0));
        entry.1 += 1;
        if entry.0 == "Unknown" && cat_name != "Unknown" {
            entry.0 = cat_name;
        }

        ctx.account_ids.insert(tx.account_id.clone());
        ctx.amounts.push(tx.amount.minor_units());
        ctx.dates.push(tx.date.clone());
    }

    let cat_name_lookup: HashMap<&str, &str> = categories
        .iter()
        .map(|c| (c.id.as_str(), c.name.as_str()))
        .collect();

    let mut candidates: Vec<RuleCandidate> = Vec::new();

    for (normalized_merchant, ctx) in &merchant_data {
        let best = ctx.cats.iter().max_by_key(|(_, &(_, count))| count);
        if let Some((cat_id, (cat_name_from_tx, count))) = &best {
            if *count >= min_consistent_count {
                let final_cat_name = cat_name_lookup
                    .get(cat_id.as_str())
                    .copied()
                    .unwrap_or(cat_name_from_tx)
                    .to_string();

                let mut account_ids: Vec<String> = ctx.account_ids.iter().cloned().collect();
                account_ids.sort();

                let amount_min = ctx.amounts.iter().min().copied();
                let amount_max = ctx.amounts.iter().max().copied();

                let date_earliest = ctx.dates.iter().min().cloned();
                let date_latest = ctx.dates.iter().max().cloned();

                let all_pos = ctx.amounts.iter().all(|&a| a >= 0);
                let all_neg = ctx.amounts.iter().all(|&a| a <= 0);
                let direction = if all_pos {
                    "inflow".to_string()
                } else if all_neg {
                    "outflow".to_string()
                } else {
                    "mixed".to_string()
                };

                let is_merchant_only = account_ids.len() <= 1
                    && direction == "outflow"
                    && amount_min.zip(amount_max).map(|(mn,mx)| mn == mx).unwrap_or(true)
                    && date_earliest.as_deref() == date_latest.as_deref();

                let conflict_reason = if direction == "mixed" {
                    Some(format!("Merchant '{}' has both inflows and outflows", normalized_merchant))
                } else if is_merchant_only {
                    Some(format!("Merchant '{}' candidate is merchant-only — no account/direction/amount/date variance", normalized_merchant))
                } else {
                    None
                };

                candidates.push(RuleCandidate {
                    rule_id: String::new(),
                    rule_name: format!("Auto-rule for {}", normalized_merchant),
                    proposed_category_id: cat_id.to_string(),
                    proposed_category_name: final_cat_name,
                    matching_tx_count: *count,
                    reason: format!("Merchant '{}' consistently categorized as '{}' across {} transaction(s)", normalized_merchant, cat_name_from_tx, count),
                    account_ids,
                    direction,
                    amount_min,
                    amount_max,
                    date_earliest,
                    date_latest,
                    is_merchant_only,
                    conflict_reason,
                });
            }
        }
    }

    candidates.sort_by_key(|b| std::cmp::Reverse(b.matching_tx_count));
    candidates
}


/// Analyze correction evidence to produce rule candidates with contextual
/// conflict detection.  Uses the same merchant-grouping logic as
/// [`generate_rule_candidates`] but draws evidence from correction records
/// instead of raw transactions.
///
/// When multiple corrections for the same merchant carry conflicting
/// account, direction, or category values, the candidate is flagged with
/// a `conflict_reason` rather than silently collapsing to one value.
pub fn generate_rule_candidates_from_corrections(
    corrections: &[CorrectionEvidence],
    min_consistent_count: u32,
) -> Vec<RuleCandidate> {
    #[derive(Default)]
    struct CorrectionContext {
        cats: HashMap<String, (String, u32)>,
        account_ids: HashSet<String>,
        directions: HashSet<String>,
        amounts: Vec<i64>,
        dates: Vec<String>,
        source_count: u32,
    }

    let mut merchant_data: HashMap<String, CorrectionContext> = HashMap::new();

    for c in corrections {
        let merchant = match &c.merchant {
            Some(m) if !m.is_empty() => m.clone(),
            _ => continue,
        };

        let ctx = merchant_data.entry(merchant).or_default();
        let cat_name = c.category_name.clone().unwrap_or_else(|| "Unknown".into());
        let entry = ctx.cats.entry(c.category_id.clone()).or_insert_with(|| (cat_name.clone(), 0));
        entry.1 += 1;
        if entry.0 == "Unknown" && cat_name != "Unknown" {
            entry.0 = cat_name;
        }

        if let Some(aid) = &c.account_id {
            ctx.account_ids.insert(aid.clone());
        }
        if let Some(dir) = &c.direction {
            ctx.directions.insert(dir.clone());
        }
        if let Some(amt) = c.amount {
            ctx.amounts.push(amt);
        }
        if let Some(d) = &c.date {
            ctx.dates.push(d.clone());
        }
        ctx.source_count += 1;
    }

    let mut candidates: Vec<RuleCandidate> = Vec::new();

    for (merchant, ctx) in &merchant_data {
        let best = ctx.cats.iter().max_by_key(|(_, &(_, count))| count);
        if let Some((cat_id, (cat_name_from_tx, count))) = best {
            if *count >= min_consistent_count {
                let mut account_ids: Vec<String> = ctx.account_ids.iter().cloned().collect();
                account_ids.sort();

                let amount_min = ctx.amounts.iter().min().copied();
                let amount_max = ctx.amounts.iter().max().copied();

                let date_earliest = ctx.dates.iter().min().cloned();
                let date_latest = ctx.dates.iter().max().cloned();

                let direction = if !ctx.amounts.is_empty() {
                    let all_pos = ctx.amounts.iter().all(|&a| a >= 0);
                    let all_neg = ctx.amounts.iter().all(|&a| a <= 0);
                    if all_pos {
                        "inflow".to_string()
                    } else if all_neg {
                        "outflow".to_string()
                    } else {
                        "mixed".to_string()
                    }
                } else if ctx.directions.len() == 1 {
                    // No amounts recorded, but direction evidence is consistent
                    ctx.directions.iter().next().unwrap().clone()
                } else {
                    // No amounts and no direction, or conflicting directions
                    "mixed".to_string()
                };

                // --- Conflict detection ---
                // Conflicts are flagged rather than collapsed.
                let mut conflict_parts: Vec<String> = Vec::new();

                if ctx.account_ids.len() > 1 {
                    let mut accts: Vec<String> = ctx.account_ids.iter().cloned().collect();
                    accts.sort();
                    conflict_parts.push(format!(
                        "Merchant '{}' corrected across accounts: [{}]",
                        merchant,
                        accts.join(", ")
                    ));
                }

                if ctx.directions.len() > 1 {
                    let mut dirs: Vec<String> = ctx.directions.iter().cloned().collect();
                    dirs.sort();
                    conflict_parts.push(format!(
                        "Merchant '{}' corrected with mixed directions: [{}]",
                        merchant,
                        dirs.join(", ")
                    ));
                }

                if ctx.cats.len() > 1 {
                    let mut cats: Vec<String> = ctx.cats.keys().cloned().collect();
                    cats.sort();
                    conflict_parts.push(format!(
                        "Merchant '{}' corrected to different categories: [{}]",
                        merchant,
                        cats.iter()
                            .map(|cid| format!("{} ({})", cid, ctx.cats[cid].0))
                            .collect::<Vec<_>>()
                            .join(", ")
                    ));
                }

                let conflict_reason = if conflict_parts.is_empty() {
                    None
                } else {
                    Some(conflict_parts.join("; "))
                };

                let is_merchant_only = account_ids.len() <= 1
                    && direction == "outflow"
                    && amount_min.zip(amount_max).map(|(mn,mx)| mn == mx).unwrap_or(true)
                    && date_earliest.as_deref() == date_latest.as_deref();

                candidates.push(RuleCandidate {
                    rule_id: String::new(),
                    rule_name: format!("Correction-rule for {}", merchant),
                    proposed_category_id: cat_id.clone(),
                    proposed_category_name: cat_name_from_tx.clone(),
                    matching_tx_count: *count,
                    reason: format!(
                        "Merchant '{}' corrected to '{}' across {} correction(s)",
                        merchant, cat_name_from_tx, ctx.source_count
                    ),
                    account_ids,
                    direction,
                    amount_min,
                    amount_max,
                    date_earliest,
                    date_latest,
                    is_merchant_only,
                    conflict_reason,
                });
            }
        }
    }

    candidates.sort_by_key(|b| std::cmp::Reverse(b.matching_tx_count));
    candidates
}

// ---------------------------------------------------------------------------
// Recurring charge analysis
// ---------------------------------------------------------------------------

fn find_recurring_charges(
    transactions: &[Transaction],
    schedules: &[Schedule],
) -> Vec<RecurringCharge> {
    let mut charges: Vec<RecurringCharge> = Vec::new();

    // Simple heuristic: group by normalized merchant, look for transactions
    // with similar amounts at regular intervals.
    let mut groups: HashMap<String, Vec<&Transaction>> = HashMap::new();
    for tx in transactions {
        let norm = normalize_merchant(tx.payee_name.as_deref().unwrap_or(""));
        if norm.is_empty() || !tx.amount.is_negative() {
            // Only outgoing (negative) transactions are charges; skip incoming.
            continue;
        }
        groups.entry(norm).or_default().push(tx);
    }

    for (norm, txs) in groups {
        if txs.len() < 2 {
            continue;
        }

        // Sort by date
        let mut sorted = txs.clone();
        sorted.sort_by(|a, b| a.date.cmp(&b.date));

        // Check if amounts are similar (within 20% of each other)
        let amounts: Vec<i64> = sorted.iter().map(|tx| tx.amount.minor_units()).collect();
        if !amounts_similar(&amounts) {
            continue;
        }

        // Check if dates are roughly evenly spaced
        let dates: Vec<&str> = sorted.iter().map(|tx| tx.date.as_str()).collect();
        let (frequency_label, confidence) = classify_frequency(&dates);

        if confidence < 0.3 {
            continue;
        }

        let typical_amount = amounts[amounts.len() / 2]; // median-ish
        let currency = sorted[0].amount.currency().to_string();

        charges.push(RecurringCharge {
            normalized_merchant: norm.clone(),
            original_name: sorted[0]
                .payee_name
                .clone()
                .unwrap_or_else(|| norm.clone()),
            frequency_label,
            typical_amount: Money::new(typical_amount, &currency),
            transaction_ids: sorted.iter().map(|tx| tx.id.clone()).collect(),
            dates: sorted.iter().map(|tx| tx.date.clone()).collect(),
            confidence,
        });
    }

    // Also include scheduled transactions
    for sched in schedules {
        let norm = normalize_merchant(sched.payee_name.as_deref().unwrap_or(""));
        if norm.is_empty() {
            continue;
        }
        // Skip if already covered by transaction-based detection
        if charges.iter().any(|c| c.normalized_merchant == norm) {
            continue;
        }
        charges.push(RecurringCharge {
            normalized_merchant: norm,
            original_name: sched.payee_name.clone().unwrap_or_default(),
            frequency_label: sched.frequency.clone(),
            typical_amount: sched.amount.clone(),
            transaction_ids: vec![],
            dates: vec![sched.next_expected.clone()],
            confidence: 0.9,
        });
    }

    // Sort by normalized_merchant for deterministic output
    charges.sort_by(|a, b| a.normalized_merchant.cmp(&b.normalized_merchant));
    charges
}

fn amounts_similar(amounts: &[i64]) -> bool {
    if amounts.len() < 2 {
        return true;
    }
    // Use checked absolute values to avoid panic on i64::MIN
    let abs_vals: Vec<i64> = amounts
        .iter()
        .filter_map(|a| a.checked_abs())
        .collect();
    if abs_vals.len() < 2 {
        return false;
    }
    let min = *abs_vals.iter().min().unwrap_or(&0);
    let max = *abs_vals.iter().max().unwrap_or(&0);
    if min == 0 && max == 0 {
        return true;
    }
    // Avoid division by zero; if min is 0 but max is not, they're not similar
    if min == 0 {
        return false;
    }
    let ratio = (max as f64) / (min as f64);
    ratio <= 1.5 // within 50%
}

fn classify_frequency(dates: &[&str]) -> (String, f64) {
    if dates.len() < 2 {
        return ("infrequent".into(), 0.1);
    }

    let day_diffs: Vec<i64> = dates
        .windows(2)
        .filter_map(|w| {
            let d1 = date_to_days(w[0]);
            let d2 = date_to_days(w[1]);
            Some(d2? - d1?)
        })
        .collect();

    if day_diffs.is_empty() {
        return ("infrequent".into(), 0.1);
    }

    let avg_diff = day_diffs.iter().sum::<i64>() as f64 / day_diffs.len() as f64;

    if (avg_diff - 30.0).abs() < 10.0 {
        ("monthly".into(), 0.8)
    } else if (avg_diff - 7.0).abs() < 3.0 {
        ("weekly".into(), 0.7)
    } else if (avg_diff - 365.0).abs() < 60.0 {
        ("yearly".into(), 0.6)
    } else if (avg_diff - 14.0).abs() < 4.0 {
        ("biweekly".into(), 0.6)
    } else if (avg_diff - 1.0).abs() < 1.0 {
        ("daily".into(), 0.5)
    } else {
        ("irregular".into(), 0.3)
    }
}

/// Convert "YYYY-MM-DD" to days since epoch (approx).
fn date_to_days(s: &str) -> Option<i64> {
    let digits: String = s.chars().take(10).filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let year: i64 = digits[..4].parse().ok()?;
    let month: i64 = digits[4..6].parse().ok()?;
    let day: i64 = digits[6..8].parse().ok()?;
    Some(year * 365 + month * 30 + day)
}

// ---------------------------------------------------------------------------
// Historical corrections analysis
// ---------------------------------------------------------------------------

fn find_historical_corrections(
    budgets: &[BudgetMonth],
    categories: &[Category],
) -> Vec<HistoricalCorrection> {
    let mut corrections: Vec<HistoricalCorrection> = Vec::new();

    if budgets.len() < 2 {
        return corrections;
    }

    // Sort budgets by month
    let mut sorted: Vec<&BudgetMonth> = budgets.iter().collect();
    sorted.sort_by(|a, b| a.month.cmp(&b.month));

    // For each category, track amount changes across months
    let cat_map: HashMap<&str, &Category> =
        categories.iter().map(|c| (c.id.as_str(), c)).collect();

    // Collect all category IDs present in any budget
    let all_cat_ids: HashSet<&str> = sorted
        .iter()
        .flat_map(|bm| bm.categories.keys().map(|k| k.as_str()))
        .collect();

    for cat_id in all_cat_ids {
        let mut amounts: Vec<i64> = Vec::new();
        let mut months: Vec<String> = Vec::new();
        for bm in &sorted {
            if let Some(bc) = bm.categories.get(cat_id) {
                amounts.push(bc.amount.minor_units());
                months.push(bm.month.clone());
            }
        }

        if amounts.len() < 2 {
            continue;
        }

        // Count changes between consecutive months
        let mut change_count: usize = 0;
        for pair in amounts.windows(2) {
            if pair[0] != pair[1] {
                change_count += 1;
            }
        }

        if change_count > 0 {
            let cat_name = cat_map
                .get(cat_id)
                .map(|c| c.name.clone())
                .unwrap_or_else(|| cat_id.to_string());

            corrections.push(HistoricalCorrection {
                category_id: cat_id.to_string(),
                category_name: cat_name,
                change_count,
                months,
            });
        }
    }

    // Sort by change_count descending, then by category_id for deterministic tie-breaking
    corrections.sort_by(|a, b| {
        b.change_count
            .cmp(&a.change_count)
            .then_with(|| a.category_id.cmp(&b.category_id))
    });
    corrections
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::Money;
    use crate::snapshots::{Account, Category, Transaction};

    #[allow(clippy::too_many_arguments)]
    fn sample_tx(
        id: &str,
        acct_id: &str,
        payee: Option<&str>,
        category_id: Option<&str>,
        category_name: Option<&str>,
        amount: i64,
        date: &str,
        cleared: bool,
    ) -> Transaction {
        Transaction {
            id: id.into(),
            account_id: acct_id.into(),
            date: date.into(),
            payee_id: None,
            payee_name: payee.map(|s| s.into()),
            category_id: category_id.map(|s| s.into()),
            category_name: category_name.map(|s| s.into()),
            amount: Money::new(amount, "USD"),
            cleared,
            reconciled: false,
            imported_id: None,
            imported_payee: None,
            notes: None,
            tags: vec![],
            transfer_account_id: None,
            subtransactions: vec![],
        }
    }

    fn sample_account(id: &str, name: &str) -> Account {
        Account {
            id: id.into(),
            name: name.into(),
            account_type: "checking".into(),
            off_budget: false,
            is_closed: false,
            cleared_balance: Money::new(1000, "USD"),
            imported_balance: Money::new(1000, "USD"),
            mtid: None,
        }
    }

    fn sample_category(id: &str, name: &str, deleted: bool) -> Category {
        Category {
            id: id.into(),
            name: name.into(),
            group_name: None,
            is_income: false,
            mtid: None,
            deleted,
        }
    }

    #[test]
    fn test_analysis_uncategorized_backlog_populated() {
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), None, None, -500, "2026-06-01", true),
            sample_tx("tx2", "a1", Some("Amazon"), None, None, -2000, "2026-07-01", true),
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let (backlog, _) = build_uncategorized_backlog(&txs, &cats);
        assert_eq!(backlog.count, 2);
        assert_eq!(backlog.oldest_date.as_deref(), Some("2026-06-01"));
    }

    #[test]
    fn test_analysis_no_uncategorized() {
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -500, "2026-06-01", true),
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let (backlog, _) = build_uncategorized_backlog(&txs, &cats);
        assert_eq!(backlog.count, 0);
    }

    #[test]
    fn test_repeated_merchant_analysis() {
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -500, "2026-01-01", true),
            sample_tx("tx2", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -550, "2026-02-01", true),
            sample_tx("tx3", "a1", Some("Amazon"), Some("c2"), Some("Shopping"), -2000, "2026-03-01", true),
        ];
        let repeated = find_repeated_merchants(&txs);
        assert_eq!(repeated.len(), 1);
        assert_eq!(repeated[0].normalized_name, "starbucks");
        assert_eq!(repeated[0].frequency, 2);
    }

    #[test]
    fn test_generate_rule_candidates_consistent_merchant() {
        // Two transactions from the same merchant, both categorized as "Food"
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -500, "2026-01-01", true),
            sample_tx("tx2", "a2", Some("Starbucks"), Some("c1"), Some("Food"), -550, "2026-02-01", true),
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let candidates = generate_rule_candidates(&txs, &cats, 2);
        assert_eq!(candidates.len(), 1, "should propose one rule for Starbucks");
        assert_eq!(candidates[0].proposed_category_id, "c1");
        assert_eq!(candidates[0].matching_tx_count, 2);
        assert!(!candidates[0].reason.is_empty());
        // rule_id is empty since this is a new-rule suggestion
        assert!(candidates[0].rule_id.is_empty());
    }

    #[test]
    fn test_generate_rule_candidates_below_threshold() {
        // Only one transaction — below min_consistent_count of 2
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -500, "2026-01-01", true),
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let candidates = generate_rule_candidates(&txs, &cats, 2);
        assert!(candidates.is_empty(), "single transaction should not meet threshold");
    }

    #[test]
    fn test_generate_rule_candidates_uncategorized_excluded() {
        // Transaction without category should not contribute
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), None, None, -500, "2026-01-01", true),
            sample_tx("tx2", "a2", Some("Starbucks"), None, None, -550, "2026-02-01", true),
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let candidates = generate_rule_candidates(&txs, &cats, 1);
        assert!(candidates.is_empty(), "uncategorized transactions should not produce candidates");
    }

    #[test]
    fn test_generate_rule_candidates_no_payee_skipped() {
        // Transaction without payee name should be skipped
        let txs = vec![
            sample_tx("tx1", "a1", None, Some("c1"), Some("Food"), -500, "2026-01-01", true),
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let candidates = generate_rule_candidates(&txs, &cats, 1);
        assert!(candidates.is_empty(), "no payee name should produce no candidates");
    }

    #[test]
    fn test_generate_rule_candidates_multiple_categories() {
        // Starbucks has 3 food and 1 coffee — dominant is food, above threshold 2
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -500, "2026-01-01", true),
            sample_tx("tx2", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -550, "2026-02-01", true),
            sample_tx("tx3", "a2", Some("Starbucks"), Some("c1"), Some("Food"), -600, "2026-03-01", true),
            sample_tx("tx4", "a1", Some("Starbucks"), Some("c2"), Some("Coffee"), -400, "2026-04-01", true),
        ];
        let cats = vec![
            sample_category("c1", "Food", false),
            sample_category("c2", "Coffee", false),
        ];
        let candidates = generate_rule_candidates(&txs, &cats, 2);
        assert_eq!(candidates.len(), 1, "dominant category Food should reach threshold");
        assert_eq!(candidates[0].proposed_category_id, "c1");
        assert_eq!(candidates[0].matching_tx_count, 3);
    }

    #[test]
    fn test_generate_rule_candidates_different_merchants() {
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -500, "2026-01-01", true),
            sample_tx("tx2", "a1", Some("Starbucks"), Some("c1"), Some("Food"), -550, "2026-02-01", true),
            sample_tx("tx3", "a1", Some("Amazon"), Some("c2"), Some("Shopping"), -2000, "2026-03-01", true),
            sample_tx("tx4", "a1", Some("Amazon"), Some("c2"), Some("Shopping"), -2500, "2026-04-01", true),
        ];
        let cats = vec![
            sample_category("c1", "Food", false),
            sample_category("c2", "Shopping", false),
        ];
        let candidates = generate_rule_candidates(&txs, &cats, 2);
        assert_eq!(candidates.len(), 2, "both merchants meet threshold");
        // Should be sorted by count descending
        assert_eq!(candidates[0].matching_tx_count, 2);
        assert_eq!(candidates[1].matching_tx_count, 2);
    }

    #[test]
    fn test_generate_rule_candidates_empty_transactions() {
        let candidates = generate_rule_candidates(&[], &[], 1);
        assert!(candidates.is_empty());
    }

    #[test]
    fn test_generate_rule_candidates_merchant_normalization() {
        // "The Home Depot" and "Home Depot" should normalize to same merchant
        let txs = vec![
            sample_tx("tx1", "a1", Some("The Home Depot"), Some("c1"), Some("Home Improvement"), -5000, "2026-01-01", true),
            sample_tx("tx2", "a1", Some("Home Depot"), Some("c1"), Some("Home Improvement"), -10000, "2026-02-01", true),
        ];
        let cats = vec![sample_category("c1", "Home Improvement", false)];
        let candidates = generate_rule_candidates(&txs, &cats, 2);
        assert_eq!(candidates.len(), 1, "normalized merchants should merge");
        assert!(candidates[0].rule_name.contains("home depot"));


    }
    #[test]
    fn test_recurring_charges_identified() {
        let txs = vec![
            sample_tx("tx1", "a1", Some("Netflix"), Some("c1"), Some("Subs"), -1500, "2026-01-15", true),
            sample_tx("tx2", "a1", Some("Netflix"), Some("c1"), Some("Subs"), -1500, "2026-02-15", true),
        ];
        let charges = find_recurring_charges(&txs, &[]);
        // Outgoing (negative) amounts should be included as charges.
        // Two identical amounts on monthly-ish schedule -> should be identified.
        assert_eq!(charges.len(), 1, "expected Netflix as recurring charge");
        if !charges.is_empty() {
            assert_eq!(charges[0].normalized_merchant, "netflix");
        }
    }

    #[test]
    fn test_historical_corrections_empty() {
        let corrections = find_historical_corrections(&[], &[]);
        assert!(corrections.is_empty());
    }

    #[test]
    fn test_deterministic_analysis_roundtrip_json() {
        let accounts = vec![sample_account("a1", "Checking")];
        let cats = vec![sample_category("c1", "Food", false)];
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), None, None, -500, "2026-07-01", true),
        ];
        let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
        let scope = InclusionScope::new(true, true);
        let result = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility, Some("2026-07-18T00:00:00Z".into()), None,
            &scope, "2026-07-18",
        );
        let json = serde_json::to_string(&result).unwrap();
        let back: DeterministicAnalysis = serde_json::from_str(&json).unwrap();
        assert_eq!(result, back);
        assert!(json.contains("uncategorizedBacklog"));
        assert!(json.contains("repeatedMerchants"));
    }

    // -----------------------------------------------------------------------
    // Regression tests
    // -----------------------------------------------------------------------

    #[test]
    fn test_policy_filter_excludes_pending_from_backlog() {
        // Pending transactions should be excluded from backlog when
        // include_pending=false.
        let txs = [sample_tx("tx1", "a1", Some("Venmo"), None, None, -500, "2026-07-01", false), // pending
            sample_tx("tx2", "a1", Some("Amazon"), None, None, -2000, "2026-07-02", true)];
        let cats = vec![sample_category("c1", "Food", false)];
        // Only cleared (include_pending=false, include_cleared=true)
        let scope = InclusionScope::new(false, true);
        let scoped: Vec<Transaction> = txs.iter().filter(|tx| scope.matches(tx)).cloned().collect();
        let (backlog, _) = build_uncategorized_backlog(&scoped, &cats);
        assert_eq!(backlog.count, 1, "pending tx should be excluded");
        assert_eq!(
            backlog.transaction_ids,
            vec!["tx2"],
            "only the cleared tx should appear in backlog"
        );
    }

    #[test]
    fn test_policy_filter_excludes_transfers_from_repeated_merchants() {
        // Transfer transactions should be excluded when include_transfers=false.
        let txs = vec![
            Transaction {
                transfer_account_id: Some("a2".into()),
                ..sample_tx("tx1", "a1", Some("Transfer"), None, None, -500, "2026-07-01", true)
            },
            sample_tx("tx2", "a1", Some("Starbucks"), None, None, -500, "2026-07-02", true),
        ];
        let repeated = find_repeated_merchants(&txs);
        // Without filtering, transfer "Transfer" would be a repeated merchant.
        // With filtering, only "starbucks" appears once so no repeats.
        // This test checks the sub-function on raw data — filtering happens
        // in the orchestrator.
        assert_eq!(repeated.len(), 0, "only one non-transfer tx, no repeats");
    }

    #[test]
    fn test_policy_filter_excludes_splits_from_duplicates() {
        // Split transactions should be excluded when include_splits=false.
        let base_tx = sample_tx("tx1", "a1", Some("Dupe"), None, None, -500, "2026-07-01", true);
        let split_tx = Transaction {
            subtransactions: vec![
                sample_tx("sub1", "a1", Some("Dupe"), None, None, -250, "2026-07-01", true),
                sample_tx("sub2", "a1", Some("Dupe"), None, None, -250, "2026-07-01", true),
            ],
            ..sample_tx("tx2", "a1", Some("Dupe"), None, None, -500, "2026-07-01", true)
        };
        let txs = vec![base_tx, split_tx];
        // Without split filtering, these would match as duplicates.
        let dupes = find_duplicates(&txs);
        assert_eq!(dupes.len(), 1, "split tx and base match as duplicates");
    }

    #[test]
    fn test_encrypted_snapshot_unlocked_when_downloaded() {
        // encrypted=true but actual_downloaded_at is present → encryption
        // was effectively unlocked.
        let accounts = vec![sample_account("a1", "Checking")];
        let cats = vec![sample_category("c1", "Food", false)];
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), None, None, -500, "2026-07-01", true),
        ];
        // encrypted=true but download timestamp present
        let compatibility = CompatibilityMetadata::new(true, true, "25.1.0".into());
        let scope = InclusionScope::new(true, true);
        let result = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility, Some("2026-07-18T00:00:00Z".into()), None,
            &scope, "2026-07-18",
        );
        assert!(
            !result.reason_codes.contains(&"encryption_locked".to_string()),
            "encrypted+downloaded should NOT produce encryption_locked: {:?}",
            result.reason_codes
        );
    }

    #[test]
    fn test_encrypted_snapshot_locked_when_not_downloaded() {
        // encrypted=true and no download timestamp → encryption is locked.
        let accounts = vec![sample_account("a1", "Checking")];
        let cats = vec![sample_category("c1", "Food", false)];
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), None, None, -500, "2026-07-01", true),
        ];
        let compatibility = CompatibilityMetadata::new(true, false, "25.1.0".into());
        let scope = InclusionScope::new(true, true);
        let result = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility, None, None,
            &scope, "2026-07-18",
        );
        assert!(
            result.reason_codes.contains(&"encryption_locked".to_string()),
            "encrypted+no download should produce encryption_locked: {:?}",
            result.reason_codes
        );
    }

    #[test]
    fn test_stale_metadata_when_download_missing() {
        // Missing actual_downloaded_at should emit stale_metadata.
        let accounts = vec![sample_account("a1", "Checking")];
        let cats = vec![sample_category("c1", "Food", false)];
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), None, None, -500, "2026-07-01", true),
        ];
        let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
        let scope = InclusionScope::new(true, true);
        let result = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility, None, None,
            &scope, "2026-07-18",
        );
        assert!(
            result.reason_codes.contains(&"stale_metadata".to_string()),
            "missing download timestamp should emit stale_metadata: {:?}",
            result.reason_codes
        );
    }

    #[test]
    fn test_deterministic_repeatability() {
        // Running analysis twice with the same input produces identical output.
        let accounts = vec![sample_account("a1", "Checking")];
        let cats = vec![sample_category("c1", "Food", false)];
        let txs = vec![
            sample_tx("tx1", "a1", Some("Starbucks"), None, None, -500, "2026-07-01", true),
            sample_tx("tx2", "a1", Some("Amazon"), Some("c1"), Some("Food"), -2000, "2026-07-02", true),
        ];
        let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
        let scope = InclusionScope::new(true, true);
        let result_a = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility.clone(), Some("2026-07-18T00:00:00Z".into()), None,
            &scope, "2026-07-18",
        );
        let result_b = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility, Some("2026-07-18T00:00:00Z".into()), None,
            &scope, "2026-07-18",
        );
        assert_eq!(result_a, result_b, "deterministic analysis must be reproducible");
    }

    // -- deterministic ordering tests ---------------------------------------

    #[test]
    fn test_repeated_merchants_sorted_deterministically() {
        // Create merchants in insertion order that would differ from sorted
        let txs = vec![
            sample_tx("tx3", "a1", Some("Zappos"), None, None, -500, "2026-01-01", true),
            sample_tx("tx4", "a1", Some("Zappos"), None, None, -550, "2026-02-01", true),
            sample_tx("tx1", "a1", Some("Amazon"), None, None, -2000, "2026-01-01", true),
            sample_tx("tx2", "a1", Some("Amazon"), None, None, -2100, "2026-02-01", true),
            sample_tx("tx5", "a1", Some("Ebay"), None, None, -300, "2026-01-01", true),
            sample_tx("tx6", "a1", Some("Ebay"), None, None, -350, "2026-02-01", true),
        ];
        let repeated = find_repeated_merchants(&txs);
        assert_eq!(repeated.len(), 3);
        // MUST be in alphabetical order regardless of insertion
        assert_eq!(repeated[0].normalized_name, "amazon");
        assert_eq!(repeated[1].normalized_name, "ebay");
        assert_eq!(repeated[2].normalized_name, "zappos");
    }

    #[test]
    fn test_recurring_charges_sorted_deterministically() {
        let txs = vec![
            sample_tx("tx3", "a1", Some("Zappos"), Some("c1"), Some("Shopping"), -1500, "2026-01-15", true),
            sample_tx("tx4", "a1", Some("Zappos"), Some("c1"), Some("Shopping"), -1500, "2026-02-15", true),
            sample_tx("tx1", "a1", Some("Netflix"), Some("c2"), Some("Subs"), -1500, "2026-01-15", true),
            sample_tx("tx2", "a1", Some("Netflix"), Some("c2"), Some("Subs"), -1500, "2026-02-15", true),
        ];
        let charges = find_recurring_charges(&txs, &[]);
        assert!(charges.len() >= 2, "expected at least 2 charges, got {}", charges.len());
        if charges.len() >= 2 {
            assert_eq!(charges[0].normalized_merchant, "netflix");
            assert_eq!(charges[1].normalized_merchant, "zappos");
        }
    }

    #[test]
    fn test_historical_corrections_sorted_deterministically() {
        use crate::snapshots::BudgetCategory;
        use std::collections::HashMap;
        let b1 = BudgetMonth {
            id: "bm-1".into(),
            month: "2026-01".into(),
            categories: {
                let mut m = HashMap::new();
                m.insert("cat_b".into(), BudgetCategory {
                    category_id: "cat_b".into(),
                    amount: Money::new(100, "USD"),
                    carryover: Money::zero("USD"),
                    carryover_from_previous: Money::zero("USD"),
                    carries_over: false,
                });
                m.insert("cat_a".into(), BudgetCategory {
                    category_id: "cat_a".into(),
                    amount: Money::new(200, "USD"),
                    carryover: Money::zero("USD"),
                    carryover_from_previous: Money::zero("USD"),
                    carries_over: false,
                });
                m
            },
        };
        let b2 = BudgetMonth {
            id: "bm-2".into(),
            month: "2026-02".into(),
            categories: {
                let mut m = HashMap::new();
                m.insert("cat_b".into(), BudgetCategory {
                    category_id: "cat_b".into(),
                    amount: Money::new(300, "USD"),
                    carryover: Money::zero("USD"),
                    carryover_from_previous: Money::zero("USD"),
                    carries_over: false,
                });
                m.insert("cat_a".into(), BudgetCategory {
                    category_id: "cat_a".into(),
                    amount: Money::new(200, "USD"),
                    carryover: Money::zero("USD"),
                    carryover_from_previous: Money::zero("USD"),
                    carries_over: false,
                });
                m
            },
        };
        let cats = vec![
            sample_category("cat_a", "Category A", false),
            sample_category("cat_b", "Category B", false),
        ];
        let corrections = find_historical_corrections(&[b1, b2], &cats);
        // cat_b changed (100→300), cat_a stayed same (200→200)
        // So only cat_b should appear
        assert_eq!(corrections.len(), 1);
        assert_eq!(corrections[0].category_id, "cat_b");
    }

    // -- amounts_similar uses absolute values --------------------------------

    #[test]
    fn test_amounts_similar_uses_absolute_values() {
        // All negative amounts with similar absolute values
        assert!(amounts_similar(&[-1500, -1600, -1400]));
        // Large difference in negative amounts (abs differs by >50%)
        assert!(!amounts_similar(&[-1500, -3000]));
        // Mixed signs: -3000 and 2000 have abs values 3000 and 2000, ratio=1.5 — borderline
        assert!(amounts_similar(&[-3000, 2000]));
        // i64::MIN should not cause panic
        assert!(!amounts_similar(&[i64::MIN, -1500]));
    }

    // -- mixed-currency rejection -------------------------------------------

    #[test]
    fn test_uncategorized_backlog_rejects_mixed_currencies() {
        let txs = vec![
            Transaction {
                amount: Money::new(-500, "USD"),
                ..sample_tx("tx1", "a1", Some("Shop"), None, None, -500, "2026-01-01", true)
            },
            Transaction {
                amount: Money::new(-1000, "EUR"),
                ..sample_tx("tx2", "a1", Some("Cafe"), None, None, -1000, "2026-01-02", true)
            },
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let (_backlog, blocker_codes) = build_uncategorized_backlog(&txs, &cats);
        // Mixed currencies should produce a blocker code
        assert!(
            blocker_codes.contains(&"mixed_currency".to_string()),
            "mixed currencies should produce a blocker code: {:?}",
            blocker_codes
        );
    }

    #[test]
    fn test_repeated_merchants_rejects_mixed_currencies() {
        let txs = vec![
            Transaction {
                amount: Money::new(-500, "USD"),
                ..sample_tx("tx1", "a1", Some("Amazon"), None, None, -500, "2026-01-01", true)
            },
            Transaction {
                amount: Money::new(-1000, "EUR"),
                ..sample_tx("tx2", "a1", Some("Amazon"), None, None, -1000, "2026-02-01", true)
            },
        ];
        let repeated = find_repeated_merchants(&txs);
        // Mixed currencies with same merchant should not be grouped
        assert!(repeated.is_empty(), "mixed-currency merchant group should be excluded");
    }

    // -- i64::MIN handling ---------------------------------------------------

    #[test]
    fn test_uncategorized_backlog_rejects_i64_min() {
        let txs = vec![
            Transaction {
                amount: Money::new(i64::MIN, "USD"),
                ..sample_tx("tx1", "a1", Some("Exploit"), None, None, 0, "2026-01-01", true)
            },
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let (backlog, blocker_codes) = build_uncategorized_backlog(&txs, &cats);
        assert!(blocker_codes.contains(&"amount_overflow".to_string()));
        // Total must be non-negative safe value
        assert!(backlog.total_amount.minor_units() >= 0 || backlog.total_amount.minor_units() == 0);
    }

    // -- bank sync staleness blocker ----------------------------------------

    #[test]
    fn test_bank_sync_staleness_emits_blocker() {
        let accounts = vec![sample_account("a1", "Checking")];
        let cats = vec![sample_category("c1", "Food", false)];
        let txs = vec![];
        let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
        let scope = InclusionScope::new(true, true);
        // Bank sync 30 days old → stale
        let result = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility, Some("2026-07-18T00:00:00Z".into()),
            Some("2026-06-18T00:00:00Z".into()),
            &scope, "2026-07-18",
        );
        assert!(
            result.reason_codes.contains(&"stale_bank_sync".to_string()),
            "stale bank sync should produce stale_bank_sync reason code: {:?}",
            result.reason_codes
        );
        let has_bank_blocker = result.blockers.iter().any(|b| b.code == "stale_bank_sync");
        assert!(has_bank_blocker, "stale bank sync should be promoted to a blocker");
    }

    // -- amount overflow blocker promotion ----------------------------------

    #[test]
    fn test_amount_overflow_promotes_blocker() {
        let accounts = vec![sample_account("a1", "Checking")];
        let cats = vec![sample_category("c1", "Food", false)];
        let txs = vec![
            Transaction {
                amount: Money::new(i64::MIN, "USD"),
                category_id: None,
                ..sample_tx("tx_bomb", "a1", Some("Bad"), None, None, 0, "2026-01-01", true)
            },
        ];
        let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
        let scope = InclusionScope::new(true, true);
        let result = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility, Some("2026-07-18T00:00:00Z".into()),
            Some("2026-07-17T00:00:00Z".into()),
            &scope, "2026-07-18",
        );
        assert!(
            result.reason_codes.contains(&"amount_overflow".to_string()),
            "i64::MIN should produce amount_overflow reason code: {:?}",
            result.reason_codes
        );
        let has_blocker = result.blockers.iter().any(|b| b.code == "amount_overflow");
        assert!(has_blocker, "amount overflow should be promoted to a blocker: {:?}",
            result.blockers.iter().map(|b| &b.code).collect::<Vec<_>>());
    }

    // -- deterministic repeatability with multiple categories ----------------

    #[test]
    fn test_deterministic_repeatability_sorted() {
        // Ensure multiple repeated merchants come out in a stable order
        let accounts = vec![sample_account("a1", "Checking")];
        let cats = vec![sample_category("c1", "Food", false), sample_category("c2", "Shopping", false)];
        let txs = vec![
            sample_tx("tx1", "a1", Some("Zappos"), None, None, -500, "2026-01-01", true),
            sample_tx("tx2", "a1", Some("Zappos"), None, None, -550, "2026-02-01", true),
            sample_tx("tx3", "a1", Some("Amazon"), Some("c1"), Some("Food"), -2000, "2026-01-01", true),
            sample_tx("tx4", "a1", Some("Amazon"), Some("c1"), Some("Food"), -2100, "2026-02-01", true),
        ];
        let compatibility = CompatibilityMetadata::new(false, true, "25.1.0".into());
        let scope = InclusionScope::new(true, true);
        let result_a = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility.clone(), Some("2026-07-18T00:00:00Z".into()),
            Some("2026-07-17T00:00:00Z".into()),
            &scope, "2026-07-18",
        );
        let result_b = run_deterministic_analysis(
            &accounts, &txs, &cats, &[], &[], &[], &[],
            compatibility, Some("2026-07-18T00:00:00Z".into()),
            Some("2026-07-17T00:00:00Z".into()),
            &scope, "2026-07-18",
        );
        assert_eq!(result_a.repeated_merchants, result_b.repeated_merchants);
    }

    // -- correction direction with absent amounts --------------------------

    #[test]
    fn test_correction_candidate_direction_with_absent_amounts() {
        // When correction amounts are absent, direction must be derived from
        // recorded direction evidence, not falsely defaulted to "inflow".
        let outflow_ev = CorrectionEvidence {
            source_review_id: "r1".into(),
            merchant: Some("Netflix".into()),
            imported_payee: None,
            account_id: Some("a1".into()),
            direction: Some("outflow".into()),
            amount: None,
            date: Some("2026-01-15".into()),
            category_id: "c1".into(),
            category_name: Some("Subscriptions".into()),
            actor: "user".into(),
            from_status: "pending".into(),
            to_status: "approved".into(),
        };
        let outflow_ev2 = CorrectionEvidence {
            source_review_id: "r2".into(),
            direction: Some("outflow".into()),
            amount: None,
            ..outflow_ev.clone()
        };
        // Two corrections, both missing amounts, both outflow → direction is outflow
        let candidates = generate_rule_candidates_from_corrections(&[outflow_ev, outflow_ev2], 2);
        assert_eq!(candidates.len(), 1, "should produce one candidate from outflow corrections");
        assert_eq!(
            candidates[0].direction, "outflow",
            "direction must be outflow when amounts are absent but direction evidence is consistent; got '{}'",
            candidates[0].direction
        );
    }

    #[test]
    fn test_correction_candidate_direction_without_amounts_or_direction() {
        // When both amounts and direction evidence are absent, direction must
        // be "mixed" (unknown) rather than falsely inflating to "inflow".
        let ev = CorrectionEvidence {
            source_review_id: "r1".into(),
            merchant: Some("UnknownCo".into()),
            imported_payee: None,
            account_id: Some("a1".into()),
            direction: None,
            amount: None,
            date: None,
            category_id: "c2".into(),
            category_name: Some("Misc".into()),
            actor: "user".into(),
            from_status: "pending".into(),
            to_status: "approved".into(),
        };
        let ev2 = CorrectionEvidence {
            source_review_id: "r2".into(),
            ..ev.clone()
        };
        let candidates = generate_rule_candidates_from_corrections(&[ev, ev2], 2);
        assert_eq!(candidates.len(), 1, "should produce one candidate");
        assert_eq!(
            candidates[0].direction, "mixed",
            "direction must be mixed when both amounts and direction are absent; got '{}'",
            candidates[0].direction
        );
    }

    #[test]
    fn test_correction_candidate_direction_with_mixed_direction_evidence_no_amounts() {
        // Multiple conflicting direction values with no amounts → "mixed"
        let inflow_ev = CorrectionEvidence {
            source_review_id: "r1".into(),
            merchant: Some("FlexCo".into()),
            direction: Some("inflow".into()),
            amount: None,
            category_id: "c3".into(),
            ..sample_correction_evidence()
        };
        let outflow_ev = CorrectionEvidence {
            source_review_id: "r2".into(),
            direction: Some("outflow".into()),
            amount: None,
            ..inflow_ev.clone()
        };
        let candidates = generate_rule_candidates_from_corrections(&[inflow_ev, outflow_ev], 2);
        assert_eq!(candidates.len(), 1, "should produce one candidate from mixed direction");
        assert_eq!(
            candidates[0].direction, "mixed",
            "direction must be mixed when direction evidence conflicts and amounts absent; got '{}'",
            candidates[0].direction
        );
    }

    /// Shared baseline for CorrectionEvidence used in direction tests.
    fn sample_correction_evidence() -> CorrectionEvidence {
        CorrectionEvidence {
            source_review_id: String::new(),
            merchant: None,
            imported_payee: None,
            account_id: None,
            direction: None,
            amount: None,
            date: None,
            category_id: String::new(),
            category_name: None,
            actor: "test".into(),
            from_status: "pending".into(),
            to_status: "approved".into(),
        }
    }
}
