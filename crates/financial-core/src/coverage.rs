//! Coverage reporting: which accounts, date ranges, and inclusion scope
//! a snapshot captures.

use serde::{Deserialize, Serialize};

use crate::snapshots::{Account, Transaction};

// ---------------------------------------------------------------------------
// DateRange
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DateRange {
    /// ISO‑8601 date of the earliest transaction (inclusive).
    pub start: String,
    /// ISO‑8601 date of the latest transaction (inclusive).
    pub end: String,
}

// ---------------------------------------------------------------------------
// InclusionScope
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InclusionScope {
    pub include_pending: bool,
    pub include_cleared: bool,
    pub include_transfers: bool,
    pub include_splits: bool,
    pub exclusion_policy: String,
}

impl InclusionScope {
    pub fn new(include_pending: bool, include_cleared: bool) -> Self {
        InclusionScope {
            include_pending,
            include_cleared,
            include_transfers: false,
            include_splits: true,
            exclusion_policy: "default".into(),
        }
    }

    /// Apply all policy filters to a single transaction.
    /// Returns `true` when the transaction should be included.
    pub fn matches(&self, tx: &crate::snapshots::Transaction) -> bool {
        // Pending / cleared filter
        if !self.include_pending && !tx.cleared {
            return false;
        }
        if !self.include_cleared && tx.cleared {
            return false;
        }
        // Transfer filter
        if !self.include_transfers && tx.transfer_account_id.is_some() {
            return false;
        }
        // Split filter
        if !self.include_splits && !tx.subtransactions.is_empty() {
            return false;
        }
        // Exclusion policy
        if self.exclusion_policy.as_str() == "strict"
            && tx.payee_name.as_deref().unwrap_or("").is_empty()
        {
            return false;
        }
        true
    }
}

// ---------------------------------------------------------------------------
// AccountCoverage
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AccountCoverage {
    pub account_id: String,
    pub account_name: String,
    pub transaction_count: u32,
    pub date_range: DateRange,
}

// ---------------------------------------------------------------------------
// CoverageReport
// ---------------------------------------------------------------------------

/// Describes which accounts are covered by the snapshot, the overall date
/// span, and which kinds of transactions were included.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CoverageReport {
    pub accounts: Vec<AccountCoverage>,
    pub overall_date_range: DateRange,
    pub inclusion_scope: InclusionScope,
    pub total_transactions: u32,
    pub accounts_missing_transactions: Vec<String>,
}

// ---------------------------------------------------------------------------
// build_coverage_report
// ---------------------------------------------------------------------------

/// Analyse the accounts and transactions in a snapshot and produce a
/// `CoverageReport`.
pub fn build_coverage_report(
    accounts: &[Account],
    transactions: &[Transaction],
    scope: &InclusionScope,
) -> CoverageReport {
    // Filtered set of transactions that match the inclusion criteria.
    let filtered: Vec<&Transaction> = transactions
        .iter()
        .filter(|tx| scope.matches(tx))
        .collect();

    let total_transactions = filtered.len() as u32;

    // Per‑account coverage
    let mut account_coverage: Vec<AccountCoverage> = Vec::new();
    let mut accounts_missing: Vec<String> = Vec::new();

    for acct in accounts {
        let txns: Vec<&&Transaction> = filtered.iter().filter(|tx| tx.account_id == acct.id).collect();
        let count = txns.len() as u32;
        if count == 0 {
            accounts_missing.push(acct.id.clone());
        }

        let date_range = if txns.is_empty() {
            DateRange {
                start: String::new(),
                end: String::new(),
            }
        } else {
            let dates: Vec<&str> = txns.iter().map(|tx| tx.date.as_str()).collect();
            let start = dates.iter().min().unwrap_or(&"").to_string();
            let end = dates.iter().max().unwrap_or(&"").to_string();
            DateRange { start, end }
        };

        account_coverage.push(AccountCoverage {
            account_id: acct.id.clone(),
            account_name: acct.name.clone(),
            transaction_count: count,
            date_range,
        });
    }

    // Overall date range from all filtered transactions
    let overall = if filtered.is_empty() {
        DateRange {
            start: String::new(),
            end: String::new(),
        }
    } else {
        let all_dates: Vec<&str> = filtered.iter().map(|tx| tx.date.as_str()).collect();
        DateRange {
            start: all_dates.iter().min().unwrap_or(&"").to_string(),
            end: all_dates.iter().max().unwrap_or(&"").to_string(),
        }
    };

    CoverageReport {
        accounts: account_coverage,
        overall_date_range: overall,
        inclusion_scope: scope.clone(),
        total_transactions,
        accounts_missing_transactions: accounts_missing,
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::Money;

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

    fn sample_tx(
        id: &str,
        account_id: &str,
        date: &str,
        cleared: bool,
        category_id: Option<&str>,
    ) -> Transaction {
        Transaction {
            id: id.into(),
            account_id: account_id.into(),
            date: date.into(),
            payee_id: None,
            payee_name: None,
            category_id: category_id.map(|s| s.into()),
            category_name: None,
            amount: Money::new(100, "USD"),
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

    #[test]
    fn test_coverage_single_account() {
        let accounts = vec![sample_account("a1", "Checking")];
        let txs = vec![
            sample_tx("tx1", "a1", "2026-01-01", true, Some("cat1")),
            sample_tx("tx2", "a1", "2026-06-15", true, None),
        ];
        let scope = InclusionScope::new(true, true);
        let report = build_coverage_report(&accounts, &txs, &scope);
        assert_eq!(report.total_transactions, 2);
        assert_eq!(report.accounts.len(), 1);
        assert_eq!(report.accounts[0].transaction_count, 2);
        assert_eq!(report.overall_date_range.start, "2026-01-01");
        assert_eq!(report.overall_date_range.end, "2026-06-15");
        assert!(report.accounts_missing_transactions.is_empty());
    }

    #[test]
    fn test_coverage_missing_transactions() {
        let accounts = vec![
            sample_account("a1", "Checking"),
            sample_account("a2", "Savings"),
        ];
        let txs = vec![sample_tx("tx1", "a1", "2026-03-01", true, Some("cat1"))];
        let scope = InclusionScope::new(true, true);
        let report = build_coverage_report(&accounts, &txs, &scope);
        assert_eq!(report.accounts[1].transaction_count, 0);
        assert_eq!(report.accounts_missing_transactions, vec!["a2"]);
    }

    #[test]
    fn test_coverage_excludes_pending() {
        let accounts = vec![sample_account("a1", "Checking")];
        let txs = vec![
            sample_tx("tx1", "a1", "2026-01-01", true, Some("cat1")),
            sample_tx("tx2", "a1", "2026-06-15", false, None),
        ];
        // include_cleared=true, include_pending=false
        let scope = InclusionScope::new(false, true);
        let report = build_coverage_report(&accounts, &txs, &scope);
        assert_eq!(report.total_transactions, 1);
        assert!(!report.inclusion_scope.include_pending);
    }

    #[test]
    fn test_coverage_roundtrip_json() {
        let accounts = vec![sample_account("a1", "Checking")];
        let txs = vec![sample_tx("tx1", "a1", "2026-03-01", true, Some("cat1"))];
        let scope = InclusionScope::new(true, true);
        let report = build_coverage_report(&accounts, &txs, &scope);
        let json = serde_json::to_string(&report).unwrap();
        let back: CoverageReport = serde_json::from_str(&json).unwrap();
        assert_eq!(report, back);
        assert!(json.contains("overallDateRange"));
    }

    #[test]
    fn test_coverage_empty_snapshot() {
        let scope = InclusionScope::new(true, true);
        let report = build_coverage_report(&[], &[], &scope);
        assert_eq!(report.total_transactions, 0);
        assert!(report.accounts.is_empty());
        assert!(report.overall_date_range.start.is_empty());
    }
}
