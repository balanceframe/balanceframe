//! N-API bindings for BalanceFrame.
//!
//! This crate exposes Rust financial logic to TypeScript via
//! N-API (napi-rs). Functions here are callable directly from
//! the node-binding package.

use napi_derive::napi;

/// Placeholder — returns the sum of two numbers.
#[napi]
pub fn add(a: i32, b: i32) -> i32 {
    a + b
}
