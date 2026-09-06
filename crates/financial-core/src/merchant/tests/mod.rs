use super::*;

#[test]
fn test_normalize_basic() {
    assert_eq!(normalize_merchant("  Starbucks  "), "starbucks");
}

#[test]
fn test_normalize_articles() {
    assert_eq!(normalize_merchant("The Home Depot"), "home depot");
    assert_eq!(normalize_merchant("a local cafe"), "local cafe");
}

#[test]
fn test_normalize_suffixes() {
    assert_eq!(normalize_merchant("Acme Inc"), "acme");
    assert_eq!(normalize_merchant("Widgets LLC."), "widgets");
    assert_eq!(normalize_merchant("Foo Corp"), "foo");
}

#[test]
fn test_normalize_combined() {
    assert_eq!(
        normalize_merchant("The Widget Company Inc."),
        "widget company"
    );
}

#[test]
fn test_normalize_empty() {
    assert_eq!(normalize_merchant(""), "");
    assert_eq!(normalize_merchant("   "), "");
}
