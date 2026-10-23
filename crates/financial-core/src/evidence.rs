//! Checked, deterministic monetary allocation for normalized financial evidence.
use crate::{Money, MoneyError};

/// Allocate a nonnegative amount by integer weights, preserving every minor unit.
///
/// Largest remainders win; equal remainders use original input order. Empty or
/// zero weights can allocate zero only. Negative amounts and overflow fail.
pub fn allocate_evidence_amount(amount: &Money, weights: &[u64]) -> Result<Vec<Money>, MoneyError> {
    if amount.minor_units() < 0 {
        return Err(MoneyError::NegativeAmount);
    }
    let total: u128 = weights.iter().map(|w| u128::from(*w)).sum();
    if total == 0 {
        return if amount.minor_units() == 0 {
            Ok(weights
                .iter()
                .map(|_| Money::new(0, amount.currency()))
                .collect())
        } else {
            Err(MoneyError::DivisionByZero)
        };
    }
    let units = amount.minor_units() as u128;
    let mut shares = Vec::with_capacity(weights.len());
    let mut remainders = Vec::with_capacity(weights.len());
    let mut allocated = 0;
    for (index, weight) in weights.iter().enumerate() {
        let product = units
            .checked_mul(u128::from(*weight))
            .ok_or(MoneyError::Overflow)?;
        let share = (product / total) as i64;
        allocated += share;
        shares.push(Money::new(share, amount.currency()));
        remainders.push((index, product % total));
    }
    remainders.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    for (index, _) in remainders
        .into_iter()
        .take((amount.minor_units() - allocated) as usize)
    {
        shares[index] = Money::new(shares[index].minor_units() + 1, amount.currency());
    }
    Ok(shares)
}

/// Validate a canonical civil date and return its ordinal, without timezone conversion.
pub fn evidence_date_ordinal(value: &str) -> Option<i64> {
    use chrono::Datelike;
    if value.len() != 10
        || !value.bytes().enumerate().all(|(i, c)| {
            if i == 4 || i == 7 {
                c == b'-'
            } else {
                c.is_ascii_digit()
            }
        })
    {
        return None;
    }
    let date = chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d").ok()?;
    (date.year() > 0).then_some(i64::from(date.num_days_from_ce()))
}
/// Validate a source timestamp with an explicit RFC3339 timezone.
pub fn evidence_timestamp_valid(value: &str) -> bool {
    chrono::DateTime::parse_from_rfc3339(value).is_ok()
}
