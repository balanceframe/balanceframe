/// Normalize a merchant / payee string for fuzzy matching.
///
/// Applies, in order:
/// 1. Trim whitespace
/// 2. Lowercase
/// 3. Strip leading articles ("the ", "a ")
/// 4. Strip common legal suffixes (" inc", " llc", " ltd", with/without dot)
/// 5. Re-trim
pub fn normalize_merchant(s: &str) -> String {
    let s = s.trim().to_lowercase();

    // Leading articles
    static PREFIXES: &[&str] = &["the ", "a "];

    // Common legal suffixes (order matters: check longer first)
    static SUFFIXES: &[&str] = &[
        " inc.", " llc.", " ltd.",
        " inc",  " llc",  " ltd",
        " corp.", " corp",
        " incorporated", " limited", " limited liability company",
    ];

    let s = strip_prefixes(&s, PREFIXES);
    let s = strip_suffixes(&s, SUFFIXES);
    s.trim().to_string()
}

fn strip_prefixes<'a>(s: &'a str, prefixes: &[&str]) -> String {
    let mut result = s;
    for &prefix in prefixes {
        if let Some(rest) = result.strip_prefix(prefix) {
            result = rest;
            break;
        }
    }
    result.to_string()
}

fn strip_suffixes<'a>(s: &'a str, suffixes: &[&str]) -> String {
    let mut result = s;
    for &suffix in suffixes {
        if let Some(rest) = result.strip_suffix(suffix) {
            result = rest;
            break;
        }
    }
    result.to_string()
}

#[cfg(test)]
mod tests {
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
}
