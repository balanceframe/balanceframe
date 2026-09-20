//! Structured reason codes and blocker types for analysis results.

use serde::{Deserialize, Serialize};

// ---------------------------------------------------------------------------
// Blocker
// ---------------------------------------------------------------------------

/// A condition that prevents the analysis from proceeding or producing
/// trustworthy results.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Blocker {
    /// Machine‑readable code (e.g. `"stale_snapshot"`, `"missing_account"`).
    pub code: String,
    /// Human‑readable explanation.
    pub message: String,
    /// ID of the entity the blocker refers to (`"_overview"` for global).
    pub entity_id: String,
}

impl Blocker {
    pub fn new(
        code: impl Into<String>,
        message: impl Into<String>,
        entity_id: impl Into<String>,
    ) -> Self {
        Blocker {
            code: code.into(),
            message: message.into(),
            entity_id: entity_id.into(),
        }
    }
}

// ---------------------------------------------------------------------------
// ReasonCode — structured enum of known reasons
// ---------------------------------------------------------------------------

/// Canonical set of reason codes used in protocol results.
///
/// Serializes to its lowercase `snake_case` name for backward‑compatible
#[derive(Debug, Clone, PartialEq)]
pub enum ReasonCode {
    /// Snapshot data is older than the staleness threshold.
    StaleSnapshot,
    /// A required account is missing from the snapshot.
    MissingAccount,
    /// Bank sync has not run recently.
    StaleBankSync,
    /// Pending transactions policy is not yet resolved.
    PendingPolicy,
    /// Duplicate transactions were detected.
    DuplicateDetected,
    /// A metadata reference (e.g. category) could not be resolved.
    UnresolvedMetadataRef,
    /// The schema version is not supported.
    UnsupportedSchemaVersion,
    /// Arithmetic overflow during checked-money operations.
    AmountOverflow,
    /// Uncategorized transactions exceed the warning threshold.
    UncategorizedExposure,
    /// A deleted category is still referenced by transactions.
    DeletedCategoryReferenced,
    /// Ledger configuration is missing or incomplete.
    MissingLedgerConfig,
    /// The connection health check failed.
    ConnectionUnhealthy,
    /// Encryption is required and the data could not be decrypted.
    EncryptionLocked,
    /// Freshness metadata is missing or unreliable.
    StaleMetadata,
    /// Transactions were excluded by the current policy filter.
    ExcludedByPolicy,
}

impl ReasonCode {
    /// Return the canonical string form of this reason.
    pub fn as_str(&self) -> &'static str {
        match self {
            ReasonCode::StaleSnapshot => "stale_snapshot",
            ReasonCode::MissingAccount => "missing_account",
            ReasonCode::StaleBankSync => "stale_bank_sync",
            ReasonCode::PendingPolicy => "pending_policy",
            ReasonCode::DuplicateDetected => "duplicate_detected",
            ReasonCode::UnresolvedMetadataRef => "unresolved_metadata_ref",
            ReasonCode::UnsupportedSchemaVersion => "unsupported_schema_version",
            ReasonCode::AmountOverflow => "amount_overflow",
            ReasonCode::UncategorizedExposure => "uncategorized_exposure",
            ReasonCode::DeletedCategoryReferenced => "deleted_category_referenced",
            ReasonCode::MissingLedgerConfig => "missing_ledger_config",
            ReasonCode::ConnectionUnhealthy => "connection_unhealthy",
            ReasonCode::EncryptionLocked => "encryption_locked",
            ReasonCode::StaleMetadata => "stale_metadata",
            ReasonCode::ExcludedByPolicy => "excluded_by_policy",
        }
    }
}

// Custom serde so that `ReasonCode` serialises as a plain string.
impl Serialize for ReasonCode {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        s.serialize_str(self.as_str())
    }
}

impl<'de> Deserialize<'de> for ReasonCode {
    fn deserialize<D: serde::Deserializer<'de>>(d: D) -> Result<Self, D::Error> {
        let s = String::deserialize(d)?;
        match s.as_str() {
            "stale_snapshot" => Ok(ReasonCode::StaleSnapshot),
            "missing_account" => Ok(ReasonCode::MissingAccount),
            "stale_bank_sync" => Ok(ReasonCode::StaleBankSync),
            "pending_policy" => Ok(ReasonCode::PendingPolicy),
            "duplicate_detected" => Ok(ReasonCode::DuplicateDetected),
            "unresolved_metadata_ref" => Ok(ReasonCode::UnresolvedMetadataRef),
            "unsupported_schema_version" => Ok(ReasonCode::UnsupportedSchemaVersion),
            "amount_overflow" => Ok(ReasonCode::AmountOverflow),
            "uncategorized_exposure" => Ok(ReasonCode::UncategorizedExposure),
            "deleted_category_referenced" => Ok(ReasonCode::DeletedCategoryReferenced),
            "missing_ledger_config" => Ok(ReasonCode::MissingLedgerConfig),
            "connection_unhealthy" => Ok(ReasonCode::ConnectionUnhealthy),
            "encryption_locked" => Ok(ReasonCode::EncryptionLocked),
            "stale_metadata" => Ok(ReasonCode::StaleMetadata),
            "excluded_by_policy" => Ok(ReasonCode::ExcludedByPolicy),
            _ => Err(serde::de::Error::unknown_variant(
                &s,
                &[
                    "stale_snapshot",
                    "missing_account",
                    "stale_bank_sync",
                    "pending_policy",
                    "duplicate_detected",
                    "unresolved_metadata_ref",
                    "unsupported_schema_version",
                    "amount_overflow",
                    "uncategorized_exposure",
                    "deleted_category_referenced",
                    "missing_ledger_config",
                    "connection_unhealthy",
                    "encryption_locked",
                    "stale_metadata",
                    "excluded_by_policy",
                ],
            )),
        }
    }
}

// ---------------------------------------------------------------------------
// Builder for collecting blockers through the analysis pipeline.
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct BlockerCollector {
    pub blockers: Vec<Blocker>,
    pub reason_codes: Vec<ReasonCode>,
}

impl BlockerCollector {
    pub fn new() -> Self {
        BlockerCollector {
            blockers: Vec::new(),
            reason_codes: Vec::new(),
        }
    }

    pub fn add_blocker(
        &mut self,
        code: impl Into<String>,
        message: impl Into<String>,
        entity_id: impl Into<String>,
    ) {
        self.blockers.push(Blocker::new(code, message, entity_id));
    }

    pub fn add_reason(&mut self, reason: ReasonCode) {
        if !self.reason_codes.contains(&reason) {
            self.reason_codes.push(reason);
        }
    }

    pub fn has_blockers(&self) -> bool {
        !self.blockers.is_empty()
    }

    pub fn string_reasons(&self) -> Vec<String> {
        self.reason_codes
            .iter()
            .map(|r| r.as_str().to_string())
            .collect()
    }
}

impl Default for BlockerCollector {
    fn default() -> Self {
        Self::new()
    }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests;
