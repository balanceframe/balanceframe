//! Data-freshness metadata and staleness detection.
//!
//! Tracks when a snapshot was downloaded, when bank sync last ran, and
//! whether the captured data is stale relative to a reference date.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// DataFreshness
// ---------------------------------------------------------------------------

/// Describes how fresh the data in a snapshot is.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DataFreshness {
    /// ISO‑8601 timestamp of when Actual data was last downloaded.
    pub actual_downloaded_at: Option<String>,
    /// ISO‑8601 timestamp of the last bank sync.
    pub bank_synced_at: Option<String>,
    /// Whether pending transactions are included in the snapshot.
    pub pending_transactions_included: bool,
    /// Computed staleness in days (based on `actual_downloaded_at` vs
    /// `reference_date`).
    pub staleness_days: u32,
    /// `true` when the snapshot data is considered stale (default threshold
    /// is 90 days since the download timestamp, or if the download timestamp
    /// itself is missing).
    pub is_stale: bool,
}

impl DataFreshness {
    /// Build a `DataFreshness` from download/bank-sync timestamps and a
    /// reference date (normally the current wall-clock time).
    ///
    /// `downloaded_at` and `bank_synced_at` SHOULD be ISO‑8601 strings.
    /// `reference_date` MUST be a valid ISO‑8601 date (or date‑time) string.
    pub fn compute(
        actual_downloaded_at: Option<String>,
        bank_synced_at: Option<String>,
        pending_transactions_included: bool,
        reference_date: &str,
    ) -> Self {
        let staleness_days = actual_downloaded_at
            .as_deref()
            .map(|d| approximate_day_diff(d, reference_date))
            .unwrap_or(u32::MAX);
        let is_stale = staleness_days > 90 || actual_downloaded_at.is_none();

        DataFreshness {
            actual_downloaded_at,
            bank_synced_at,
            pending_transactions_included,
            staleness_days,
            is_stale,
        }
    }
}

// ---------------------------------------------------------------------------
// CompatibilityMetadata
// ---------------------------------------------------------------------------

/// Compatibility and encryption state reported by the connector.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CompatibilityMetadata {
    /// `true` when the Actual budget encryption key is required for access.
    pub encryption_key_required: bool,
    /// `true` when the encryption key was correctly provided.
    pub encryption_unlocked: bool,
    /// Actual server version string (e.g. `"25.1.0"`).
    pub actual_version: String,
    /// `true` when `actual_version` falls within the supported range.
    pub version_compatible: bool,
    /// Optional message describing any compatibility concern.
    pub compatibility_message: Option<String>,
}

impl CompatibilityMetadata {
    /// Supported Actual server versions (semver‑ish).
    const MIN_SUPPORTED: &'static str = "24.1.0";
    const MAX_SUPPORTED: &'static str = "26.99.99";

    pub fn new(
        encryption_key_required: bool,
        encryption_unlocked: bool,
        actual_version: String,
    ) -> Self {
        let version_compatible = is_version_in_range(
            &actual_version,
            Self::MIN_SUPPORTED,
            Self::MAX_SUPPORTED,
        );
        let compatibility_message = if !version_compatible {
            Some(format!(
                "Actual version {} is outside supported range {}..{}",
                actual_version,
                Self::MIN_SUPPORTED,
                Self::MAX_SUPPORTED,
            ))
        } else {
            None
        };

        CompatibilityMetadata {
            encryption_key_required,
            encryption_unlocked,
            actual_version,
            version_compatible,
            compatibility_message,
        }
    }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/// Approximate day count between two ISO‑8601 date strings using
/// lexicographic comparison on the compact `YYYYMMDD` form.
fn approximate_day_diff(earlier: &str, later: &str) -> u32 {
    let e = compact_date(earlier).unwrap_or(0);
    let l = compact_date(later).unwrap_or(0);
    l.saturating_sub(e)
}

fn compact_date(s: &str) -> Option<u32> {
    let digits: String = s.chars().take(10).filter(|c| c.is_ascii_digit()).collect();
    digits.parse::<u32>().ok()
}

/// Simple three‑component version comparison (MAJOR.MINOR.PATCH).
fn is_version_in_range(version: &str, min: &str, max: &str) -> bool {
    fn parse_version(v: &str) -> (u32, u32, u32) {
        let parts: Vec<&str> = v.split('.').collect();
        let major = parts.first().and_then(|s| s.parse().ok()).unwrap_or(0);
        let minor = parts.get(1).and_then(|s| s.parse().ok()).unwrap_or(0);
        let patch = parts.get(2).and_then(|s| s.parse().ok()).unwrap_or(0);
        (major, minor, patch)
    }
    let v = parse_version(version);
    let lo = parse_version(min);
    let hi = parse_version(max);
    v >= lo && v <= hi
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
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
}
