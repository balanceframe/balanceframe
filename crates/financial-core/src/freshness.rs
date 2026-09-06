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
    /// Computed bank-sync staleness in days (based on `bank_synced_at` vs
    /// `reference_date`).
    #[serde(default)]
    pub bank_staleness_days: u32,
    /// `true` when bank sync is considered stale (>7 days since last sync,
    /// or missing entirely).
    #[serde(default)]
    pub bank_sync_stale: bool,
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
            .map(|d| calendar_day_diff(d, reference_date).unwrap_or(u32::MAX))
            .unwrap_or(u32::MAX);
        let is_stale = staleness_days > 90 || actual_downloaded_at.is_none();

        let (bank_staleness_days, bank_sync_stale) = bank_synced_at
            .as_deref()
            .map(|bs| {
                let days = calendar_day_diff(bs, reference_date).unwrap_or(u32::MAX);
                (days, days > 7)
            })
            .unwrap_or((u32::MAX, true));

        DataFreshness {
            actual_downloaded_at,
            bank_synced_at,
            pending_transactions_included,
            staleness_days,
            is_stale,
            bank_staleness_days,
            bank_sync_stale,
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
        let version_compatible =
            is_version_in_range(&actual_version, Self::MIN_SUPPORTED, Self::MAX_SUPPORTED);
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

/// Compute the difference in calendar days between two ISO‑8601 date strings.
///
/// Returns `None` when either date cannot be parsed.
fn calendar_day_diff(earlier: &str, later: &str) -> Option<u32> {
    let e = epoch_days(earlier)?;
    let l = epoch_days(later)?;
    if l >= e {
        Some((l - e) as u32)
    } else {
        Some(0)
    }
}

/// Rata Die days since 1970-01-01 (proleptic Gregorian).
///
/// Uses a civil‑date algorithm adapted from Howard Hinnant.
fn epoch_days(s: &str) -> Option<i64> {
    let digits: String = s.chars().take(10).filter(|c| c.is_ascii_digit()).collect();
    if digits.len() < 8 {
        return None;
    }
    let y: i64 = digits[..4].parse().ok()?;
    let m: i64 = digits[4..6].parse().ok()?;
    let d: i64 = digits[6..8].parse().ok()?;
    if !(1..=12).contains(&m) || !(1..=31).contains(&d) {
        return None;
    }
    let (y, m) = if m <= 2 { (y - 1, m + 12) } else { (y, m) };
    let era = y.div_euclid(400);
    let yoe = y - era * 400; // [0, 399]
    let doy = (153 * (m - 3) + 2) / 5 + d - 1; // [0, 365]
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy; // [0, 146096]
    Some(era * 146097 + doe - 719468)
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
#[cfg(test)]
mod tests;
