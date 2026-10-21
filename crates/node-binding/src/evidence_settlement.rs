//! Native receipt settlement allocation planning uses the existing protocol boundary.
use balanceframe_core_protocol as cp;
use napi_derive::napi;
/// Derive an approval-required allocation without creating a new ledger mutation path.
#[napi]
pub fn derive_evidence_settlement_plan(input: String) -> napi::Result<String> {
    super::run(input, |request: cp::DeriveEvidenceSettlementPlanRequest| {
        cp::derive_evidence_settlement_plan(&request).map_err(|error| error.to_string())
    })
}

/// Derive explicit receipt-line funding matrices without authorizing any mutation.
#[napi]
pub fn derive_evidence_allocation_plan(input: String) -> napi::Result<String> {
    super::run(input, |request: cp::DeriveEvidenceAllocationPlanRequest| {
        cp::derive_evidence_allocation_plan(&request).map_err(|error| error.to_string())
    })
}
