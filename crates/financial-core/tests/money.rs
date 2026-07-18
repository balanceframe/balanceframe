use balanceframe_financial_core::{Money, MoneyError};

#[test]
fn test_overflow_on_add_of_max() {
    let max = Money::new(i64::MAX, "USD");
    let one = Money::new(1, "USD");
    let result = max.add(&one);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), MoneyError::Overflow);
}

#[test]
fn test_currency_mismatch() {
    let usd = Money::new(100, "USD");
    let eur = Money::new(200, "EUR");
    let result = usd.add(&eur);
    assert!(result.is_err());
    match result.unwrap_err() {
        MoneyError::CurrencyMismatch(a, b) => {
            assert_eq!(a, "USD");
            assert_eq!(b, "EUR");
        }
        _ => panic!("expected CurrencyMismatch"),
    }
}

#[test]
fn test_zero_amount() {
    let a = Money::zero("USD");
    let b = Money::zero("USD");
    let result = a.add(&b).unwrap();
    assert_eq!(result, Money::new(0, "USD"));
    assert!(result.is_zero());
}

#[test]
fn test_negative_amounts() {
    let neg = Money::new(-100, "USD");
    let pos = Money::new(50, "USD");
    let result = neg.add(&pos).unwrap();
    assert_eq!(result, Money::new(-50, "USD"));
    assert!(neg.is_negative());
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
fn test_checked_sub_underflow_returns_none() {
    // Attempt to subtract 1 from i64::MIN underflows
    let min = Money::new(i64::MIN, "USD");
    let one = Money::new(1, "USD");
    let result = min.sub(&one);
    assert!(result.is_err());
    assert_eq!(result.unwrap_err(), MoneyError::Overflow);
}

#[test]
fn test_mul_by_usize_overflow() {
    let big = Money::new(i64::MAX, "USD");
    assert!(matches!(big.mul_by_usize(2), Err(MoneyError::Overflow)));
}

#[test]
fn test_div_by_zero() {
    let m = Money::new(100, "USD");
    assert!(matches!(m.div_by_usize(0), Err(MoneyError::DivisionByZero)));
}

#[test]
fn test_display_format() {
    assert_eq!(Money::new(1234, "USD").to_string(), "$12.34");
    assert_eq!(Money::new(0, "USD").to_string(), "$0.00");
    assert_eq!(Money::new(-500, "USD").to_string(), "-$5.00");
    assert_eq!(Money::new(123456, "USD").to_string(), "$1234.56");
}
