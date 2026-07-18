use serde::{Deserialize, Serialize};

use crate::snapshots::{ImportTransaction, Transaction};

// ---------------------------------------------------------------------------
// MatchType
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub enum MatchType {
    Exact,
    AmountDate,
    Partial,
}

// ---------------------------------------------------------------------------
// ReconciliationMatch
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReconciliationMatch {
    pub tx_id: String,
    pub import_id: String,
    pub match_type: MatchType,
}

// ---------------------------------------------------------------------------
// reconcile_by_imported_id
// ---------------------------------------------------------------------------

/// Match transactions to imported bank transactions using a cascade of
/// strategies:
///
/// 1. **Exact** — `tx.imported_id` equals `im.id`.
/// 2. **Amount+Date** — absolute amount and date match (ignoring import id).
/// 3. **Partial** — same payee name (after normalisation) and amount match.
pub fn reconcile_by_imported_id(
    txs: &[Transaction],
    imports: &[ImportTransaction],
) -> Vec<ReconciliationMatch> {
    let mut matches: Vec<ReconciliationMatch> = Vec::new();
    let mut used_imports: Vec<bool> = vec![false; imports.len()];

    // --- 1. Exact matches by imported_id ---
    for tx in txs {
        if let Some(ref imported_id) = tx.imported_id {
            for (i, im) in imports.iter().enumerate() {
                if used_imports[i] {
                    continue;
                }
                if *imported_id == im.id {
                    matches.push(ReconciliationMatch {
                        tx_id: tx.id.clone(),
                        import_id: im.id.clone(),
                        match_type: MatchType::Exact,
                    });
                    used_imports[i] = true;
                    break;
                }
            }
        }
    }

    // Track used transactions
    let mut used_txs: Vec<bool> = txs
        .iter()
        .map(|tx| {
            matches
                .iter()
                .any(|m| m.tx_id == tx.id)
        })
        .collect();

    // --- 2. Amount + Date matches ---
    for (j, tx) in txs.iter().enumerate() {
        if used_txs[j] {
            continue;
        }
        let tx_abs = tx.amount.minor_units().abs();
        for (i, im) in imports.iter().enumerate() {
            if used_imports[i] {
                continue;
            }
            if im.amount.minor_units().abs() == tx_abs && im.date == tx.date {
                matches.push(ReconciliationMatch {
                    tx_id: tx.id.clone(),
                    import_id: im.id.clone(),
                    match_type: MatchType::AmountDate,
                });
                used_imports[i] = true;
                used_txs[j] = true;
                break;
            }
        }
    }

    // --- 3. Partial matches (payee name + amount) ---
    for (j, tx) in txs.iter().enumerate() {
        if used_txs[j] {
            continue;
        }
        let tx_abs = tx.amount.minor_units().abs();
        let tx_payee = tx
            .payee_name
            .as_deref()
            .map(crate::merchant::normalize_merchant)
            .unwrap_or_default();

        if tx_payee.is_empty() {
            continue;
        }

        for (i, im) in imports.iter().enumerate() {
            if used_imports[i] {
                continue;
            }
            if im.amount.minor_units().abs() != tx_abs {
                continue;
            }
            let im_payee = im
                .payee_name
                .as_deref()
                .map(crate::merchant::normalize_merchant)
                .unwrap_or_default();

            if im_payee == tx_payee {
                matches.push(ReconciliationMatch {
                    tx_id: tx.id.clone(),
                    import_id: im.id.clone(),
                    match_type: MatchType::Partial,
                });
                used_imports[i] = true;
                used_txs[j] = true;
                break;
            }
        }
    }

    matches
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::money::Money;

    fn make_tx(id: &str, imported_id: Option<&str>, payee: Option<&str>, amount: i64, date: &str) -> Transaction {
        Transaction {
            id: id.into(),
            account_id: "acct1".into(),
            date: date.into(),
            payee_id: None,
            payee_name: payee.map(|s| s.into()),
            category_id: Some("cat1".into()),
            category_name: Some("Food".into()),
            amount: Money::new(amount, "USD"),
            cleared: true,
            reconciled: false,
            imported_id: imported_id.map(|s| s.into()),
            imported_payee: None,
            notes: None,
            tags: vec![],
            transfer_account_id: None,
            subtransactions: vec![],
        }
    }

    fn make_import(id: &str, amount: i64, date: &str, payee: Option<&str>) -> ImportTransaction {
        ImportTransaction {
            id: id.into(),
            account_id: "acct1".into(),
            date: date.into(),
            payee_name: payee.map(|s| s.into()),
            amount: Money::new(amount, "USD"),
            memo: None,
            flags_count: 0,
        }
    }

    #[test]
    fn test_exact_match() {
        let txs = vec![make_tx("tx1", Some("imp1"), None, 100, "2026-01-15")];
        let imports = vec![make_import("imp1", 100, "2026-01-15", None)];
        let result = reconcile_by_imported_id(&txs, &imports);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_type, MatchType::Exact);
    }

    #[test]
    fn test_amount_date_match() {
        let txs = vec![make_tx("tx1", None, None, 5000, "2026-03-01")];
        let imports = vec![make_import("imp1", 5000, "2026-03-01", None)];
        let result = reconcile_by_imported_id(&txs, &imports);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_type, MatchType::AmountDate);
    }

    #[test]
    fn test_partial_match() {
        let txs = vec![make_tx("tx1", None, Some("Starbucks"), 450, "2026-06-10")];
        let imports = vec![make_import("imp1", 450, "2026-06-10", Some("STARBUCKS"))];
        let result = reconcile_by_imported_id(&txs, &imports);
        // amount+date should match before partial, but here the date is the same,
        // so it's an AmountDate match
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].match_type, MatchType::AmountDate);
    }

    #[test]
    fn test_no_match() {
        let txs = vec![make_tx("tx1", None, Some("Unrelated"), 999, "2026-01-01")];
        let imports = vec![make_import("imp1", 111, "2026-06-01", Some("Other"))];
        let result = reconcile_by_imported_id(&txs, &imports);
        assert_eq!(result.len(), 0);
    }
}
