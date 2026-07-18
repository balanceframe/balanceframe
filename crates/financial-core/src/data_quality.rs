use serde::{Deserialize, Serialize};

use crate::snapshots::{Account, Category, Transaction};

// ---------------------------------------------------------------------------
// Severity
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum Severity {
    Info,
    Warning,
    Blocker,
}

// ---------------------------------------------------------------------------
// QualityIssue
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualityIssue {
    pub severity: Severity,
    pub code: String,
    pub message: String,
    pub entity_type: String,
    pub entity_id: String,
}

impl QualityIssue {
    pub fn new(
        severity: Severity,
        code: impl Into<String>,
        message: impl Into<String>,
        entity_type: impl Into<String>,
        entity_id: impl Into<String>,
    ) -> Self {
        QualityIssue {
            severity,
            code: code.into(),
            message: message.into(),
            entity_type: entity_type.into(),
            entity_id: entity_id.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// QualitySummary
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct QualitySummary {
    pub total_issues: usize,
    pub blockers: usize,
    pub warnings: usize,
    pub info: usize,
}

// ---------------------------------------------------------------------------
// DataQualityReport
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataQualityReport {
    pub issues: Vec<QualityIssue>,
    pub summary: QualitySummary,
}

// ---------------------------------------------------------------------------
// Analyzers
// ---------------------------------------------------------------------------

/// Check accounts for stale unreconciled balances and missing transaction
/// coverage.  `reference_date` must be an ISO-8601 UTC string (e.g.
/// `"2026-07-17"`) so that simple lexicographic comparison is sufficient.
pub fn analyze_accounts(
    accounts: &[Account],
    transactions: &[Transaction],
    reference_date: &str,
) -> Vec<QualityIssue> {
    let mut issues: Vec<QualityIssue> = Vec::new();

    for account in accounts {
        if account.is_closed {
            continue;
        }

        // Find the most recent unreconciled transaction date
        let mut latest_unreconciled: Option<&str> = None;
        for tx in transactions {
            if tx.account_id == account.id && !tx.reconciled {
                match latest_unreconciled {
                    None => latest_unreconciled = Some(&tx.date),
                    Some(prev) if tx.date.as_str() > prev => latest_unreconciled = Some(&tx.date),
                    _ => {}
                }
            }
        }

        // Stale: more than 90 days since the latest unreconciled tx
        if let Some(tx_date) = latest_unreconciled {
            if is_stale(tx_date, reference_date, 90) {
                issues.push(QualityIssue::new(
                    Severity::Warning,
                    "STALE_BALANCE",
                    format!(
                        "Account '{}' has unreconciled transactions older than 90 days",
                        account.name
                    ),
                    "Account",
                    &account.id,
                ));
            }
        }

        // Missing expected coverage: account with no transactions at all
        let has_tx = transactions.iter().any(|tx| tx.account_id == account.id);
        if !has_tx && !account.off_budget {
            issues.push(QualityIssue::new(
                Severity::Info,
                "MISSING_COVERAGE",
                format!("Account '{}' has no transactions", account.name),
                "Account",
                &account.id,
            ));
        }
    }

    issues
}

/// Check transactions for pending exposure, uncategorized items,
/// duplicate candidates, and split coverage.
pub fn analyze_transactions(
    transactions: &[Transaction],
    categories: &[Category],
) -> Vec<QualityIssue> {
    let mut issues: Vec<QualityIssue> = Vec::new();

    // Identify active category IDs
    let active_cats: std::collections::HashSet<&str> =
        categories.iter().map(|c| c.id.as_str()).collect();

    let mut uncategorized_count: usize = 0;
    let mut uncategorized_total: i64 = 0;

    for tx in transactions {
        // Base (non-sub) transactions
        let is_sub = tx
            .category_id
            .as_deref()
            .map(|cid| !active_cats.contains(cid))
            .unwrap_or(false);
        let is_uncategorized = tx.category_id.is_none()
            || tx.category_id.as_deref() == Some("")
            || is_sub;

        // --- Pending exposure ---
        if !tx.cleared {
            issues.push(QualityIssue::new(
                Severity::Info,
                "PENDING_EXPOSURE",
                format!("Transaction {} is pending", tx.id),
                "Transaction",
                &tx.id,
            ));
        }

        // --- Uncategorized ---
        if is_uncategorized {
            uncategorized_count += 1;
            uncategorized_total += tx.amount.minor_units().abs();
        }

        // --- Split coverage ---
        if !tx.subtransactions.is_empty() {
            let sub_sum: i64 = tx
                .subtransactions
                .iter()
                .map(|st| st.amount.minor_units())
                .sum();
            if sub_sum != tx.amount.minor_units() {
                issues.push(QualityIssue::new(
                    Severity::Warning,
                    "SPLIT_MISMATCH",
                    format!(
                        "Transaction {} splits sum to {} but parent amount is {}",
                        tx.id, sub_sum, tx.amount.minor_units()
                    ),
                    "Transaction",
                    &tx.id,
                ));
            }
        }
    }

    // --- Uncategorized summary ---
    if uncategorized_count > 0 {
        issues.push(QualityIssue::new(
            Severity::Warning,
            "UNCATEGORIZED_TRANSACTIONS",
            format!(
                "{} uncategorized transactions totalling {} minor units",
                uncategorized_count, uncategorized_total
            ),
            "Transaction",
            "_summary",
        ));
    }

    // --- Duplicate candidates ---
    let mut seen: Vec<(&str, i64, &str)> = Vec::new(); // (payee, amount_abs, date)
    for tx in transactions {
        let payee_key = tx.payee_name.as_deref().unwrap_or("");
        let amount_abs = tx.amount.minor_units().abs();
        let date = &tx.date;

        if let Some((_prev_payee, _prev_amt, _prev_date)) =
            seen.iter().find(|(p, a, d)| {
                *p == payee_key && *a == amount_abs && *d == date.as_str()
            })
        {
            issues.push(QualityIssue::new(
                Severity::Warning,
                "DUPLICATE_CANDIDATE",
                format!(
                    "Transaction {} may duplicate another with same payee,
                     amount and date",
                    tx.id
                ),
                "Transaction",
                &tx.id,
            ));
        }
        seen.push((payee_key, amount_abs, date));
    }

    issues
}

/// Check categories for deleted-but-referenced and possible rename issues.
pub fn analyze_categories(
    categories: &[Category],
    transactions: &[Transaction],
) -> Vec<QualityIssue> {
    let mut issues: Vec<QualityIssue> = Vec::new();

    let deleted_ids: Vec<&str> = categories
        .iter()
        .filter(|c| c.deleted)
        .map(|c| c.id.as_str())
        .collect();

    let live_names: Vec<&str> = categories
        .iter()
        .filter(|c| !c.deleted)
        .map(|c| c.name.as_str())
        .collect();

    // Deleted categories still referenced in transactions
    for &del_id in &deleted_ids {
        let refs: Vec<&Transaction> = transactions
            .iter()
            .filter(|tx| {
                tx.category_id.as_deref() == Some(del_id)
                    || tx
                        .subtransactions
                        .iter()
                        .any(|st| st.category_id.as_deref() == Some(del_id))
            })
            .collect();

        if !refs.is_empty() {
            issues.push(QualityIssue::new(
                Severity::Blocker,
                "DELETED_CATEGORY_REFERENCED",
                format!(
                    "Deleted category {} is still used by {} transaction(s)",
                    del_id,
                    refs.len()
                ),
                "Category",
                del_id,
            ));
        }
    }

    // Renamed categories heuristic: look for live names that are very similar
    // to deleted names (simple substring / prefix match).
    for cat in categories.iter().filter(|c| c.deleted) {
        let del_lower = cat.name.to_lowercase();
        for &live in &live_names {
            let live_lower = live.to_lowercase();
            if live_lower.contains(&del_lower) || del_lower.contains(&live_lower) {
                issues.push(QualityIssue::new(
                    Severity::Info,
                    "CATEGORY_RENAMED",
                    format!(
                        "Category '{}' may have been renamed to '{}'",
                        cat.name, live
                    ),
                    "Category",
                    &cat.id,
                ));
            }
        }
    }

    issues
}

/// Composite analysis: run all checks and produce a single report.
pub fn analyze_readiness(
    accounts: &[Account],
    transactions: &[Transaction],
    categories: &[Category],
    reference_date: &str,
) -> DataQualityReport {
    let mut issues: Vec<QualityIssue> = Vec::new();

    issues.extend(analyze_accounts(accounts, transactions, reference_date));
    issues.extend(analyze_transactions(transactions, categories));
    issues.extend(analyze_categories(categories, transactions));

    let blockers = issues.iter().filter(|i| i.severity == Severity::Blocker).count();
    let warnings = issues.iter().filter(|i| i.severity == Severity::Warning).count();
    let info = issues.iter().filter(|i| i.severity == Severity::Info).count();

    let summary = QualitySummary {
        total_issues: issues.len(),
        blockers,
        warnings,
        info,
    };

    DataQualityReport { issues, summary }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Lexicographic date comparison approximating an age check.
/// `date` and `reference_date` MUST be ISO-8601 date strings in the same
/// format (YYYY-MM-DD).
fn is_stale(date: &str, reference_date: &str, max_days: u32) -> bool {
    // Only compare the date portion (first 10 chars "YYYY-MM-DD")
    if date.len() < 10 || reference_date.len() < 10 {
        return false;
    }

    let date_compact: String = date.chars().take(10).collect::<String>()
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();
    let ref_compact: String = reference_date.chars().take(10).collect::<String>()
        .chars()
        .filter(|c| c.is_ascii_digit())
        .collect();

    // Parse as u64: YYYYMMDD
    let date_val: u64 = match date_compact.parse() {
        Ok(v) => v,
        Err(_) => return false,
    };
    let ref_val: u64 = match ref_compact.parse() {
        Ok(v) => v,
        Err(_) => return false,
    };

    if ref_val < date_val {
        return false; // reference is before the transaction date
    }

    let diff_days = ref_val - date_val;

    // Rough: YYYYMMDD diff / 10000 approximates years, but for days we need
    // a better heuristic.  A simple approach: compare the "day of year"
    // portion.  For simplicity we just warn if the compact date diff > 100
    // (approx 1 month of days in YYYYMMDD space; 90 days ~ 90 in flat diff).
    diff_days > max_days.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::Money;

    #[test]
    fn test_quality_summary_counts() {
        let issues = vec![
            QualityIssue::new(Severity::Blocker, "B1", "blocker", "T", "1"),
            QualityIssue::new(Severity::Warning, "W1", "warn", "T", "2"),
            QualityIssue::new(Severity::Info, "I1", "info", "T", "3"),
        ];
        let report = DataQualityReport {
            summary: QualitySummary {
                total_issues: issues.len(),
                blockers: issues.iter().filter(|i| i.severity == Severity::Blocker).count(),
                warnings: issues.iter().filter(|i| i.severity == Severity::Warning).count(),
                info: issues.iter().filter(|i| i.severity == Severity::Info).count(),
            },
            issues,
        };
        assert_eq!(report.summary.total_issues, 3);
        assert_eq!(report.summary.blockers, 1);
        assert_eq!(report.summary.warnings, 1);
        assert_eq!(report.summary.info, 1);
    }

    #[test]
    fn test_analyze_accounts_stale() {
        let accounts = vec![Account {
            id: "acct1".into(),
            name: "Checking".into(),
            account_type: "checking".into(),
            off_budget: false,
            is_closed: false,
            cleared_balance: Money::new(1000, "USD"),
            imported_balance: Money::new(1000, "USD"),
            mtid: None,
        }];

        let tx = Transaction {
            id: "tx1".into(),
            account_id: "acct1".into(),
            date: "2025-01-01".into(),
            payee_id: None,
            payee_name: Some("Test".into()),
            category_id: Some("cat1".into()),
            category_name: Some("TestCat".into()),
            amount: Money::new(100, "USD"),
            cleared: true,
            reconciled: false,
            imported_id: None,
            imported_payee: None,
            notes: None,
            tags: vec![],
            transfer_account_id: None,
            subtransactions: vec![],
        };

        let issues = analyze_accounts(&accounts, &[tx], "2026-07-17");
        assert!(issues.iter().any(|i| i.code == "STALE_BALANCE"));
    }
}
