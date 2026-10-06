//! Canonical native merchant-analysis boundary, shared with financial-core.
//!
//! Models have strict typed serde validation; the protocol does not maintain a
//! second classifier or convert civil dates through timestamps.

pub use balanceframe_financial_core::merchant_intelligence::{
    MerchantAccountCoverage, MerchantAlias, MerchantAliasState, MerchantAlternative,
    MerchantAnalysisError, MerchantAnalysisRequest, MerchantAnalysisResult, MerchantCalendar,
    MerchantCategoryClassification, MerchantCategoryHistory, MerchantCategoryHistoryEntry,
    MerchantCollectionState, MerchantCollections, MerchantCorrection, MerchantCorrectionState,
    MerchantCoverage, MerchantCurrencyState, MerchantDecisionState, MerchantDirection,
    MerchantEvidence, MerchantEvidenceKind, MerchantEvidenceTier, MerchantFrequency,
    MerchantHoliday, MerchantNativeRuleBlock, MerchantNativeRuleClassification,
    MerchantNativeRulePart, MerchantNativeRuleSet, MerchantOccurrenceDistribution,
    MerchantPatternDecision, MerchantPatternState, MerchantPendingState, MerchantRecurrence,
    MerchantRecurrenceKind, MerchantRuleCandidate, MerchantSchedule, MerchantScheduledExpectation,
    MerchantScope, MerchantSourceAdmission, MerchantSuggestion, MerchantSuggestionPage,
    MerchantSuggestionSelection, MerchantTextField, MerchantTextState, MerchantTransaction,
};

/// Evaluate an already-authorized merchant capture without providers or ledger writes.
///
/// Input/identity failures are typed; no panic or raw source text is used as a
/// fallback result. Application delivery still requires current source grants.
pub fn analyze_merchant_intelligence(
    request: &MerchantAnalysisRequest,
) -> Result<MerchantAnalysisResult, MerchantAnalysisError> {
    balanceframe_financial_core::analyze_merchant_intelligence(request)
}
