# balanceframe-core-protocol

Serde-compatible protocol types for BalanceFrame.

Shared data structures used across the Rust and TypeScript layers, designed for serialization via serde and exposure through N-API bindings.

## Pre-commitment Decision Card

`evaluate_decision_card(DecisionCardRequest)` evaluates a trusted normalized
`FinancialSnapshot`, governed account/category policy, and the shared liquidity
claim revision. Its versioned `DecisionCard` retains the request, snapshot, policy,
and plan identities; separate category-funding and payment-account outcomes;
before/after category, account, goal, obligation, and runway projections; exact
transfer/reallocation paths and approvals; evidence coverage, blockers, and expiry.
Joint account capacity and transfer timing come from the existing account-aware
Rust evaluator. Future assignments cannot fund current spending, and an
insufficient-data result never implies a safe after-state. This function makes no
ledger or workflow mutation; the N-API boundary is `evaluateDecisionCard`.
