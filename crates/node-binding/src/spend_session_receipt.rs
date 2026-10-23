//! Comparison-only N-API boundary; source authentication remains application-owned.
use balanceframe_core_protocol as cp;
use napi_derive::napi;

/// Compare one saved intent with receipt facts without emitting financial actions.
#[napi]
pub fn compare_spend_session_receipt(input: String) -> napi::Result<String> {
    super::run(input, |request: cp::CompareSpendSessionReceiptRequest| {
        cp::compare_spend_session_receipt(&request).map_err(|error| error.to_string())
    })
}
