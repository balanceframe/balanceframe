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
    let (uncategorized_backlog, blocker_codes) =
        build_uncategorized_backlog(&scoped_txns, categories);
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
            let cat_name = tx.category_name.clone().unwrap_or_else(|| "Unknown".into());
            let cat_id = tx.category_id.clone().unwrap_or_default();
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
            Some(abs) => match total_minor.checked_add(abs) {
                Some(s) => total_minor = s,
                None => {
                    blocker_codes.push("amount_overflow".into());
                }
            },
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

            let original_names: Vec<String> =
                txs.iter().filter_map(|tx| tx.payee_name.clone()).collect();
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
        let cat_name = tx.category_name.clone().unwrap_or_else(|| "Unknown".into());
        let normalized = normalize_merchant(payee);
        if normalized.is_empty() {
            continue;
        }

        let ctx = merchant_data.entry(normalized).or_default();
        let entry = ctx
            .cats
            .entry(cat_id)
            .or_insert_with(|| (cat_name.clone(), 0));
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
                    && amount_min
                        .zip(amount_max)
                        .map(|(mn, mx)| mn == mx)
                        .unwrap_or(true)
                    && date_earliest.as_deref() == date_latest.as_deref();

                let conflict_reason = if direction == "mixed" {
                    Some(format!(
                        "Merchant '{}' has both inflows and outflows",
                        normalized_merchant
                    ))
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
                    reason: format!(
                        "Merchant '{}' consistently categorized as '{}' across {} transaction(s)",
                        normalized_merchant, cat_name_from_tx, count
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
        let entry = ctx
            .cats
            .entry(c.category_id.clone())
            .or_insert_with(|| (cat_name.clone(), 0));
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
                    && amount_min
                        .zip(amount_max)
                        .map(|(mn, mx)| mn == mx)
                        .unwrap_or(true)
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
            original_name: sorted[0].payee_name.clone().unwrap_or_else(|| norm.clone()),
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
    let abs_vals: Vec<i64> = amounts.iter().filter_map(|a| a.checked_abs()).collect();
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
    let cat_map: HashMap<&str, &Category> = categories.iter().map(|c| (c.id.as_str(), c)).collect();

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
#[cfg(test)]
mod tests;
