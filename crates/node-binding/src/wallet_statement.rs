//! Native statement preview does not grant source or financial mutation authority.
use balanceframe_core_protocol as cp;
use napi_derive::napi;
/// Compute current activity fingerprints and checked totals for explicit human attestation.
#[napi]
pub fn derive_wallet_statement_preview(input: String) -> napi::Result<String> {
    super::run(input, |request: cp::DeriveWalletStatementPreviewRequest| {
        cp::derive_wallet_statement_preview(&request).map_err(|error| error.to_string())
    })
}
