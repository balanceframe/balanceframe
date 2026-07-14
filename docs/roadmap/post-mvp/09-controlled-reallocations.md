# Phase 9 — Controlled reallocations

**Depends on:** Phase 8 analysis and Phase 7 governance  
**Status:** Post-MVP

## Objective

Turn a conservative `safe_with_reallocation` analysis into an exact, policy-governed proposal. Reallocation remains a distinct consequential financial action, never an inference side effect.

## Deliverables

- Propose exact donor/recipient reallocations with stable category IDs, amounts, source snapshot/version, policy version, protected-category status, donor minimum balance, rationale/reason codes, expiry, hash, required approvals, and idempotency key.
- Reuse the normal authorization → latest snapshot → Rust plan/hash → Actual write → Actual re-read → Rust postcondition → audit path. There is no direct model-to-Actual or special budget-write route.
- Enforce assistance mode: analysis only, recommend actions, create approval proposal, or execute approved actions. Space policy sets a maximum; actor capabilities can only reduce it; a model cannot escalate it.
- Protect configured categories; detect donor conflicts and concurrent proposals; re-evaluate donor funds, freshness, coverage, pending/uncleared/uncategorized policy, and all preconditions immediately before execution.
- Require policy-defined approval thresholds/multiple approvers. A changed source state, expired or consumed approval, payload mismatch, or insufficient data invalidates the proposal.
- Display the tradeoff: what category loses funds, what minimum/buffer remains, what target/bill may be affected, what assumptions were used, and which action is proposed versus executed. Preserve envelope availability separately from cash-flow projections.

## Tests

Fully funded purchase; approved safe reallocation; protected category refusal; minimum-balance/cash-buffer refusal; stale bank/snapshot; material uncategorized/pending policy; credit-card/payment-category treatment; competing proposals for same donors; external Actual edits; expired/replayed approval; multi-approver thresholds; crash recovery; and postcondition mismatch.

## Exit

**Stale or concurrent proposals cannot double-use funds, evade policy-defined approvals, or violate protected-category policy.**