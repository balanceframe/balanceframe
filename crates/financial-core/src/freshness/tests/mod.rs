use super::*;

// -- stale snapshot tests -----------------------------------------------

#[test]
fn test_freshness_stale_when_missing_download() {
    let f = DataFreshness::compute(None, None, true, "2026-07-18");
    assert!(f.is_stale);
    assert_eq!(f.staleness_days, u32::MAX);
}

#[test]
fn test_freshness_stale_when_older_than_90_days() {
    let dl = Some("2025-01-01T12:00:00Z".into());
    let f = DataFreshness::compute(dl, None, true, "2026-07-18");
    assert!(f.is_stale);
    assert!(f.staleness_days > 90);
}

#[test]
fn test_freshness_fresh_when_recent() {
    let dl = Some("2026-07-17T12:00:00Z".into());
    let f = DataFreshness::compute(dl, None, true, "2026-07-18");
    assert!(!f.is_stale);
    assert_eq!(f.staleness_days, 1);
}

#[test]
fn test_freshness_tracks_bank_sync() {
    let dl = Some("2026-07-17T12:00:00Z".into());
    let bs = Some("2026-07-18T08:00:00Z".into());
    let f = DataFreshness::compute(dl, bs.clone(), false, "2026-07-18");
    assert_eq!(f.bank_synced_at, bs);
    assert!(!f.pending_transactions_included);
}

// -- CompatibilityMetadata tests ---------------------------------------

#[test]
fn test_compatibility_known_version() {
    let c = CompatibilityMetadata::new(false, true, "25.1.0".into());
    assert!(c.version_compatible);
    assert!(c.compatibility_message.is_none());
    assert!(!c.encryption_key_required);
}

#[test]
fn test_compatibility_old_version_rejected() {
    let c = CompatibilityMetadata::new(true, false, "23.0.0".into());
    assert!(!c.version_compatible);
    assert!(c.compatibility_message.is_some());
    assert!(c.encryption_key_required);
    assert!(!c.encryption_unlocked);
}

#[test]
fn test_compatibility_metadata_roundtrip_json() {
    let c = CompatibilityMetadata::new(true, true, "26.5.0".into());
    let json = serde_json::to_string(&c).unwrap();
    let back: CompatibilityMetadata = serde_json::from_str(&json).unwrap();
    assert_eq!(c, back);
    // Verify camelCase keys
    assert!(json.contains("encryptionKeyRequired"));
    assert!(json.contains("actualVersion"));
}

// -- version range tests ------------------------------------------------

#[test]
fn test_version_in_range_exact_min() {
    assert!(is_version_in_range("24.1.0", "24.1.0", "26.99.99"));
}

#[test]
fn test_version_in_range_exact_max() {
    assert!(is_version_in_range("26.99.99", "24.1.0", "26.99.99"));
}

#[test]
fn test_version_below_min() {
    assert!(!is_version_in_range("23.12.0", "24.1.0", "26.99.99"));
}

#[test]
fn test_version_above_max() {
    assert!(!is_version_in_range("27.0.0", "24.1.0", "26.99.99"));
}

#[test]
fn test_version_malformed_defaults_to_zero() {
    // Not parseable → (0,0,0) which is below min
    assert!(!is_version_in_range("garbage", "24.1.0", "26.99.99"));
}

// -- calendar-day difference tests --------------------------------------

#[test]
fn test_calendar_day_diff_same_day() {
    assert_eq!(
        calendar_day_diff("2026-07-18", "2026-07-18").unwrap_or(u32::MAX),
        0
    );
}

#[test]
fn test_calendar_day_diff_cross_month() {
    // July 31 → Aug 1 = 1 day (would be wrong with YYYYMMDD subtraction)
    assert_eq!(
        calendar_day_diff("2026-07-31", "2026-08-01").unwrap_or(u32::MAX),
        1
    );
}

#[test]
fn test_calendar_day_diff_cross_year() {
    // Dec 31 → Jan 1 = 1 day
    assert_eq!(
        calendar_day_diff("2025-12-31", "2026-01-01").unwrap_or(u32::MAX),
        1
    );
}

#[test]
fn test_calendar_day_diff_leap_year_extra_day() {
    // 2024 is leap year: Feb 28 → Mar 1 = 2 days
    // Non-leap: Feb 28 → Mar 1 = 1 day
    assert_eq!(
        calendar_day_diff("2024-02-28", "2024-03-01").unwrap_or(u32::MAX),
        2
    );
}

#[test]
fn test_calendar_day_diff_large_gap() {
    let diff = calendar_day_diff("2025-01-01", "2026-07-18").unwrap_or(u32::MAX);
    assert!(diff > 500 && diff < 600, "expected ~563 days, got {}", diff);
}

#[test]
fn test_calendar_day_diff_malformed_earlier_returns_max() {
    assert_eq!(calendar_day_diff("not-a-date", "2026-07-18"), None);
}

#[test]
fn test_calendar_day_diff_backward_returns_zero() {
    // later is earlier than earlier → should be 0 (clamped)
    assert_eq!(calendar_day_diff("2026-07-18", "2026-07-15"), Some(0));
}

// -- bank sync staleness tests ------------------------------------------

#[test]
fn test_bank_sync_stale_when_missing() {
    let f = DataFreshness::compute(
        Some("2026-07-18T00:00:00Z".into()),
        None,
        true,
        "2026-07-18",
    );
    assert!(f.bank_sync_stale);
    assert_eq!(f.bank_staleness_days, u32::MAX);
}

#[test]
fn test_bank_sync_fresh_when_recent() {
    let bs = Some("2026-07-17T00:00:00Z".into());
    let f = DataFreshness::compute(Some("2026-07-18T00:00:00Z".into()), bs, true, "2026-07-18");
    assert!(!f.bank_sync_stale);
    assert_eq!(f.bank_staleness_days, 1);
}

#[test]
fn test_bank_sync_stale_when_older_than_7_days() {
    let bs = Some("2026-07-10T00:00:00Z".into());
    let f = DataFreshness::compute(Some("2026-07-18T00:00:00Z".into()), bs, true, "2026-07-18");
    assert!(f.bank_sync_stale);
    assert!(f.bank_staleness_days > 7);
}

#[test]
fn test_bank_sync_not_stale_at_exactly_7_days() {
    let bs = Some("2026-07-11T00:00:00Z".into());
    let f = DataFreshness::compute(Some("2026-07-18T00:00:00Z".into()), bs, true, "2026-07-18");
    assert!(!f.bank_sync_stale, "7 days should still be fresh");
    assert_eq!(f.bank_staleness_days, 7);
}
