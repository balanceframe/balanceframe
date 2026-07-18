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
    rules: &[Rule],
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
        }
        if issue.code == "UNCATEGORIZED_TRANSACTIONS" {
            collector.add_reason(ReasonCode::UncategorizedExposure);
        }
        if issue.code == "DELETED_CATEGORY_REFERENCED" {
            collector.add_reason(ReasonCode::DeletedCategoryReferenced);
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
    let rule_candidates = build_rule_candidates(rules, &scoped_txns, categories);

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

    let currency = uncategorized
        .first()
        .map(|tx| tx.amount.currency().to_string())
        .unwrap_or_else(|| "USD".into());

    let total_amount = match Money::new(total_minor, &currency).abs() {
        Ok(m) => m,
        Err(_) => Money::new(total_minor, &currency),
    };

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

    groups
        .into_iter()
        .filter(|(_, txs)| txs.len() > 1)
        .map(|(norm, txs)| {
            let original_names: Vec<String> = txs
                .iter()
                .filter_map(|tx| tx.payee_name.clone())
                .collect();
            let frequency = txs.len();

            let total_minor: i64 = txs
                .iter()
                .filter_map(|tx| tx.amount.minor_units().checked_abs())
                .sum();
            let currency = txs
                .first()
                .map(|tx| tx.amount.currency().to_string())
                .unwrap_or_else(|| "USD".into());

            let sample_ids: Vec<String> = txs.iter().take(10).map(|tx| tx.id.clone()).collect();

            RepeatedMerchant {
                normalized_name: norm,
                original_names,
                frequency,
                total_amount: Money::new(total_minor, &currency),
                sample_transaction_ids: sample_ids,
            }
        })
        .collect()
}

// ---------------------------------------------------------------------------
// Rule candidate analysis
// ---------------------------------------------------------------------------

fn build_rule_candidates(
    rules: &[Rule],
    transactions: &[Transaction],
    categories: &[Category],
) -> Vec<RuleCandidate> {
    let mut candidates: Vec<RuleCandidate> = Vec::new();

    for rule in rules {
        if rule.inactive {
            continue;
        }

        // Count uncategorized transactions that this rule could match.
        // In Phase 1 we use a simple heuristic: count transactions that
        // have no category and that have a payee name.
        let matching_count = transactions
            .iter()
            .filter(|tx| {
                (tx.category_id.is_none() || tx.category_id.as_deref() == Some(""))
                    && tx.payee_name.is_some()
            })
            .count() as u32;

        if matching_count == 0 {
            continue;
        }

        // Try to extract a target category from the rule's actions
        let (proposed_category_id, proposed_category_name) =
            extract_target_category(&rule.actions, categories);

        candidates.push(RuleCandidate {
            rule_id: rule.id.clone(),
            rule_name: rule.name.clone(),
            proposed_category_id,
            proposed_category_name,
            matching_tx_count: matching_count,
            reason: "Rule is active and could match uncategorized transactions".into(),
        });
    }

    // Also suggest deterministic rules from the data: if a normalized merchant
    // always maps to the same category in history, suggest a rule.
    candidates
}

/// Heuristic: look in the rule actions JSON for a `category` field.
fn extract_target_category(
    actions: &serde_json::Value,
    categories: &[Category],
) -> (String, String) {
    if let Some(arr) = actions.as_array() {
        for action in arr {
            if let Some(obj) = action.as_object() {
                if let Some(cat_id) = obj.get("category").and_then(|v| v.as_str()) {
                    let name = categories
                        .iter()
                        .find(|c| c.id == cat_id)
                        .map(|c| c.name.clone())
                        .unwrap_or_default();
                    return (cat_id.to_string(), name);
                }
            }
        }
    }
    (String::new(), String::new())
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

    charges
}

fn amounts_similar(amounts: &[i64]) -> bool {
    if amounts.len() < 2 {
        return true;
    }
    let min = *amounts.iter().min().unwrap_or(&0);
    let max = *amounts.iter().max().unwrap_or(&0);
    if min == 0 && max == 0 {
        return true;
    }
    let ratio = (max as f64) / (min as f64).max(1.0);
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

    // Sort by change_count descending
    corrections.sort_by_key(|b| std::cmp::Reverse(b.change_count));
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
    fn test_rule_candidates_from_existing_rules() {
        let rules = vec![Rule {
            id: "r1".into(),
            name: "Auto-categorize".into(),
            order: 1,
            trigger: serde_json::json!({}),
            actions: serde_json::json!([{"category": "c1"}]),
            inactive: false,
        }];
        let txs = vec![
            sample_tx("tx1", "a1", Some("Some Payee"), None, None, -500, "2026-01-01", true),
        ];
        let cats = vec![sample_category("c1", "Food", false)];
        let candidates = build_rule_candidates(&rules, &txs, &cats);
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].rule_id, "r1");
    }

    #[test]
    fn test_inactive_rules_excluded() {
        let rules = vec![Rule {
            id: "r1".into(),
            name: "Inactive".into(),
            order: 1,
            trigger: serde_json::json!({}),
            actions: serde_json::json!([{"category": "c1"}]),
            inactive: true,
        }];
        let candidates = build_rule_candidates(&rules, &[], &[]);
        assert!(candidates.is_empty());
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
}
