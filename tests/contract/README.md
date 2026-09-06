# Contract Tests

Cross-boundary contract tests verifying TypeScript/Rust protocol compatibility.

Ensures that generated types, serialization, and N-API interfaces remain in sync.

`account-aware-liquidity.test.ts` validates the shared Rust liquidity fixture through
strict TypeScript and independent JSON Schema boundaries, including signed-i64
overflow, unknown-field rejection, explicit unavailable facts, and independent
future/category semantics.
