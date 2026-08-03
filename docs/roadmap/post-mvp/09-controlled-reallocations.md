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

### Reusable consequential-action contract

Reallocations are the first specialization of one ordinary consequential-action pipeline. The pipeline must also support later approved manual/split transactions, evidence-derived ledger projections, wallet-account materialization, and transfer proposals without an agent-only or feature-specific write route.

Every action type defines stable target IDs, exact amounts/currency, source snapshot/version, policy version, evidence references, preconditions, expiry, canonical payload hash, idempotency key, authorization disposition, required approvers, and deterministic postconditions. A changed source record, account/category state, evidence resolution, cart, funding path, or payload invalidates approval and requires a new plan.

Reallocation proposals retain typed reason and impact metadata, including account-readiness, payment-route, transfer-need, reservation/commitment, and evidence-resolution effects. This metadata explains the proposal; it does not weaken protected-category, donor, freshness, or approval checks.

An Actual transfer record is a ledger representation, not proof that an institution transfer settled. Transfer workflow confirmation requires the later deterministic settlement evidence defined by Phase 8.7.

## Tests

Fully funded purchase; approved safe reallocation; protected category refusal; minimum-balance/cash-buffer refusal; stale bank/snapshot; material uncategorized/pending policy; credit-card/payment-category treatment; competing proposals for same donors; account-readiness/transfer-need reason metadata; stale evidence or changed funding path; exact composite action hash; approved manual/split transaction and evidence-derived projection reuse of the pipeline; ledger-only transfer versus deterministic settlement confirmation; external Actual edits; expired/replayed approval; multi-approver thresholds; crash recovery; and postcondition mismatch.

## Exit

**Stale or concurrent proposals cannot double-use funds, evade policy-defined approvals, or violate protected-category policy.**
