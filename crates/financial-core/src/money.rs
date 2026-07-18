use serde::{Deserialize, Deserializer, Serialize, Serializer};
use std::fmt;
use thiserror::Error;

// ---------------------------------------------------------------------------
// MoneyError
// ---------------------------------------------------------------------------

#[derive(Error, Debug, Clone, PartialEq)]
pub enum MoneyError {
    #[error("currency mismatch: {0} vs {1}")]
    CurrencyMismatch(String, String),

    #[error("arithmetic overflow")]
    Overflow,

    #[error("division by zero")]
    DivisionByZero,

    #[error("negative amount not allowed")]
    NegativeAmount,
}

// ---------------------------------------------------------------------------
// Money
// ---------------------------------------------------------------------------

/// A monetary amount stored in minor units (e.g. cents) with a 3-char currency code.
///
/// Serialized as `{ "minorUnits": "1234", "currency": "USD" }`.
#[derive(Debug, Clone, PartialEq)]
pub struct Money {
    minor_units: i64,
    currency: String,
}

// -- custom serde for minor_units as a JSON string -------------------------

mod minor_units_serde {
    use serde::{de, Deserialize, Deserializer};

    pub fn deserialize<'de, D>(deserializer: D) -> Result<i64, D::Error>
    where
        D: Deserializer<'de>,
    {
        let s = String::deserialize(deserializer)?;
        s.parse::<i64>().map_err(de::Error::custom)
    }
}

impl Serialize for Money {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        use serde::ser::SerializeStruct;
        let mut state = serializer.serialize_struct("Money", 2)?;
        state.serialize_field("minorUnits", &self.minor_units.to_string())?;
        state.serialize_field("currency", &self.currency)?;
        state.end()
    }
}

impl<'de> Deserialize<'de> for Money {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        #[derive(Deserialize)]
        #[serde(rename_all = "camelCase")]
        struct MoneyHelper {
            #[serde(with = "minor_units_serde")]
            minor_units: i64,
            currency: String,
        }
        let helper = MoneyHelper::deserialize(deserializer)?;
        Ok(Money {
            minor_units: helper.minor_units,
            currency: helper.currency,
        })
    }
}

// -- constructor helpers ---------------------------------------------------

impl Money {
    /// Create a `Money` from minor units and a currency code.
    pub fn new(minor_units: i64, currency: impl Into<String>) -> Self {
        Money {
            minor_units,
            currency: currency.into(),
        }
    }

    /// Zero in the given currency.
    pub fn zero(currency: impl Into<String>) -> Self {
        Money {
            minor_units: 0,
            currency: currency.into(),
        }
    }

    // -- accessors ---------------------------------------------------------

    pub fn minor_units(&self) -> i64 {
        self.minor_units
    }

    pub fn currency(&self) -> &str {
        &self.currency
    }

    // -- arithmetic, checked -----------------------------------------------

    /// Add two money values (same currency).
    pub fn add(&self, other: &Money) -> Result<Money, MoneyError> {
        if self.currency != other.currency {
            return Err(MoneyError::CurrencyMismatch(
                self.currency.clone(),
                other.currency.clone(),
            ));
        }
        let result = self
            .minor_units
            .checked_add(other.minor_units)
            .ok_or(MoneyError::Overflow)?;
        Ok(Money {
            minor_units: result,
            currency: self.currency.clone(),
        })
    }

    /// Subtract two money values (same currency).
    pub fn sub(&self, other: &Money) -> Result<Money, MoneyError> {
        if self.currency != other.currency {
            return Err(MoneyError::CurrencyMismatch(
                self.currency.clone(),
                other.currency.clone(),
            ));
        }
        // checked_sub catches i64::MIN - 1 etc; we also reject going
        // negative when the caller expects non-negative, but the core
        // operation itself is legal for negative results.
        let result = self
            .minor_units
            .checked_sub(other.minor_units)
            .ok_or(MoneyError::Overflow)?;
        Ok(Money {
            minor_units: result,
            currency: self.currency.clone(),
        })
    }

    /// Multiply by a non-negative integer factor.
    pub fn mul_by_usize(&self, multiplier: usize) -> Result<Money, MoneyError> {
        let mult = i64::try_from(multiplier).map_err(|_| MoneyError::Overflow)?;
        let result = self
            .minor_units
            .checked_mul(mult)
            .ok_or(MoneyError::Overflow)?;
        Ok(Money {
            minor_units: result,
            currency: self.currency.clone(),
        })
    }

    /// Floor-divide by a positive integer divisor.
    pub fn div_by_usize(&self, divisor: usize) -> Result<Money, MoneyError> {
        if divisor == 0 {
            return Err(MoneyError::DivisionByZero);
        }
        let div = i64::try_from(divisor).map_err(|_| MoneyError::Overflow)?;
        let result = self
            .minor_units
            .checked_div(div)
            .ok_or(MoneyError::Overflow)?;
        Ok(Money {
            minor_units: result,
            currency: self.currency.clone(),
        })
    }

    // -- predicates --------------------------------------------------------

    pub fn is_negative(&self) -> bool {
        self.minor_units < 0
    }

    pub fn is_zero(&self) -> bool {
        self.minor_units == 0
    }

    /// Absolute value (same currency).
    ///
    /// Returns `MoneyError::Overflow` when `minor_units` is `i64::MIN`
    /// because `-i64::MIN` overflows `i64`.
    pub fn abs(&self) -> Result<Money, MoneyError> {
        let abs = self
            .minor_units
            .checked_abs()
            .ok_or(MoneyError::Overflow)?;
        Ok(Money {
            minor_units: abs,
            currency: self.currency.clone(),
        })
    }
}

impl fmt::Display for Money {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        // Use checked_abs to safely handle i64::MIN (which overflows i64::abs).
        match self.minor_units.checked_abs() {
            Some(abs) => {
                let dollars = abs / 100;
                let cents = abs % 100;
                if self.minor_units < 0 {
                    write!(f, "-${}.{:02}", dollars, cents)
                } else {
                    write!(f, "${}.{:02}", dollars, cents)
                }
            }
            None => {
                // i64::MIN = -9_223_372_036_854_775_808 does not have a
                // representable positive counterpart; the largest positive
                // i64 is 9_223_372_036_854_775_807, so we display that plus
                // one cent to signal the overflow magnitude.
                let abs = i64::MAX;
                let dollars = abs / 100;
                let cents = abs % 100;
                write!(f, "-${}.{:02}", dollars, cents + 1)
            }
        }
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_add() {
        let a = Money::new(100, "USD");
        let b = Money::new(250, "USD");
        assert_eq!(a.add(&b).unwrap(), Money::new(350, "USD"));
    }

    #[test]
    fn test_add_overflow() {
        let a = Money::new(i64::MAX, "USD");
        let b = Money::new(1, "USD");
        assert!(matches!(a.add(&b), Err(MoneyError::Overflow)));
    }

    #[test]
    fn test_currency_mismatch() {
        let a = Money::new(100, "USD");
        let b = Money::new(100, "EUR");
        assert!(matches!(a.add(&b), Err(MoneyError::CurrencyMismatch(_, _))));
    }

    #[test]
    fn test_sub_underflow() {
        let a = Money::new(i64::MIN, "USD");
        let b = Money::new(1, "USD");
        assert!(matches!(a.sub(&b), Err(MoneyError::Overflow)));
    }

    #[test]
    fn test_sub_negative_ok() {
        let a = Money::new(50, "USD");
        let b = Money::new(100, "USD");
        assert_eq!(a.sub(&b).unwrap(), Money::new(-50, "USD"));
    }

    #[test]
    fn test_zero_amount() {
        let a = Money::zero("USD");
        let b = Money::zero("USD");
        assert_eq!(a.add(&b).unwrap(), Money::zero("USD"));
        assert!(a.is_zero());
    }

    #[test]
    fn test_negative_amounts() {
        let a = Money::new(-100, "USD");
        let b = Money::new(50, "USD");
        assert_eq!(a.add(&b).unwrap(), Money::new(-50, "USD"));
        assert!(a.is_negative());
    }

    #[test]
    fn test_mul_by_usize() {
        let a = Money::new(100, "USD");
        assert_eq!(a.mul_by_usize(3).unwrap(), Money::new(300, "USD"));
    }

    #[test]
    fn test_mul_overflow() {
        let a = Money::new(i64::MAX, "USD");
        assert!(matches!(a.mul_by_usize(2), Err(MoneyError::Overflow)));
    }

    #[test]
    fn test_div_by_usize() {
        let a = Money::new(100, "USD");
        assert_eq!(a.div_by_usize(3).unwrap(), Money::new(33, "USD"));
    }

    #[test]
    fn test_div_by_zero() {
        let a = Money::new(100, "USD");
        assert!(matches!(a.div_by_usize(0), Err(MoneyError::DivisionByZero)));
    }

    #[test]
    fn test_display() {
        assert_eq!(Money::new(1234, "USD").to_string(), "$12.34");
        assert_eq!(Money::new(0, "USD").to_string(), "$0.00");
        assert_eq!(Money::new(5, "USD").to_string(), "$0.05");
        assert_eq!(Money::new(-500, "USD").to_string(), "-$5.00");
        assert_eq!(Money::new(123456, "USD").to_string(), "$1234.56");
    }

    #[test]
    fn test_serialize_roundtrip() {
        let m = Money::new(1234, "USD");
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(json, r#"{"minorUnits":"1234","currency":"USD"}"#);
        let back: Money = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }

    #[test]
    fn test_abs_overflow_i64_min() {
        let m = Money::new(i64::MIN, "USD");
        assert!(matches!(m.abs(), Err(MoneyError::Overflow)));
    }

    #[test]
    fn test_abs_normal() {
        let m = Money::new(-500, "USD");
        assert_eq!(m.abs().unwrap(), Money::new(500, "USD"));
        assert!(!Money::new(300, "USD").abs().unwrap().is_negative());
        assert_eq!(Money::new(0, "USD").abs().unwrap(), Money::new(0, "USD"));
    }

    #[test]
    fn test_display_i64_min() {
        let m = Money::new(i64::MIN, "USD");
        // i64::MIN = -9223372036854775808 → formatted as -$92233720368547758.08
        let s = m.to_string();
        assert!(s.starts_with("-$"));
        assert!(s.len() > 10);
    }
    #[test]
    fn test_serialize_negative() {
        let m = Money::new(-50, "EUR");
        let json = serde_json::to_string(&m).unwrap();
        assert_eq!(json, r#"{"minorUnits":"-50","currency":"EUR"}"#);
        let back: Money = serde_json::from_str(&json).unwrap();
        assert_eq!(m, back);
    }
}
