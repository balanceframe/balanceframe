# @balanceframe/protocol-generated

TypeScript mirrors of the Rust-owned canonical protocol, with runtime Zod validators.

`src/liquidity.ts` exports documented ordinary interfaces for account-aware requests,
facts, evidence, policy, joint scenarios, claims, backing allocations, transfer plans,
settlement records/results, and transfer precondition verification. Public type names
match Rust; records use camelCase and choices use snake_case.

Import types from `@balanceframe/protocol-generated` and strict runtime schemas from
`@balanceframe/protocol-generated/validators` using the lower-camel type name plus
`Schema` (for example, `accountAwareSpendabilityRequestSchema`, `liquidityFactsSchema`,
`transferPlanSchema`, or `verifyTransferPreconditionsRequestSchema`).

Money minor units are canonical bounded signed-i64 decimal strings. Missing facts
never default to complete evidence. `FinancialSnapshot.liquidity` and
`PurchaseEvaluation.accountAware` are additive nullable/optional fields, so old
canonical snapshots remain readable without asserting account readiness.

These are trusted native/service contracts, not public HTTP input authorization.
Arithmetic, routing, allocation, and plan identity remain Rust-owned.
