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
        let digits = s.strip_prefix('-').unwrap_or(&s);
        if digits.is_empty()
            || !digits.bytes().all(|byte| byte.is_ascii_digit())
            || (digits.starts_with('0') && (digits.len() != 1 || s.starts_with('-')))
        {
            return Err(de::Error::custom(
                "minorUnits must be canonical signed decimal",
            ));
        }
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
        let abs = self.minor_units.checked_abs().ok_or(MoneyError::Overflow)?;
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
#[cfg(test)]
mod tests;
