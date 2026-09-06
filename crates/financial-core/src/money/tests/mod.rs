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
