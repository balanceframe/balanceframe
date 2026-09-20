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
        .map(|tx| matches.iter().any(|m| m.tx_id == tx.id))
        .collect();

    // --- 2. Amount + Date matches ---
    for (j, tx) in txs.iter().enumerate() {
        if used_txs[j] {
            continue;
        }
        let tx_abs = tx.amount.minor_units().unsigned_abs();
        for (i, im) in imports.iter().enumerate() {
            if used_imports[i] {
                continue;
            }
            if im.amount.minor_units().unsigned_abs() == tx_abs && im.date == tx.date {
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
        let tx_abs = tx.amount.minor_units().unsigned_abs();
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
            if im.amount.minor_units().unsigned_abs() != tx_abs {
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
#[cfg(test)]
mod tests;
