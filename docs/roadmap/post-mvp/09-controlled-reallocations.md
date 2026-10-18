# Phase 9 — Controlled reallocations

**Depends on:** Phase 8 analysis and Phase 7 governance  
**Status:** Implemented (unreleased)

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

## Implementation verification — 2026-10-17

The native, application, workflow-store, HTTP and UI paths implement the shared consequential-action contract. Independent correctness and complexity reviews of the completed changes found no must-fix issues.

All seven authenticated disposable Actual acceptance cases pass through the production application: exact reallocation with independent quorum and replay, approved split debit, donor competition, protected-category refusal, stale external assignment refusal, stable wallet materialization/replay, and reciprocal ledger-only transfer without institution settlement.

Real Chromium against source Nuxt with authentication bypass disabled verified two distinct human approvals (quorum 0 → 1 → 2), explicit execution, a deliberately lost success response followed by status refresh, and read-only reconciliation replay. USD minor-unit assignments changed donor 4000 → 2000 and recipient 0 → 2000; cash remained 15000 and transaction rows stayed identical. A separate acquired-but-undispatched action retained its hold after **Check prior execution**, with execution disabled and Actual unchanged. Expired recovery is covered by native/application regressions; it was not exercised in the browser.

Immediate server-derived manual/split and evidence-projection debits survive approval delay within the original UTC date. Approved timestamps/hashes remain fixed, current freshness and expiry still apply, and crossing midnight requires a new proposal. Scheduled and unrelated cart deadlines remain binding. See [ADR 0003](../../adr/0003-space-governance-and-exact-authority.md) for the exact boundary and the external-editor/exclusive-ownership limit.

Final verification passes: 799 Rust tests and 5,885 Vitest tests, with no failed, skipped or pending cases. The complete 355-test scenario suite satisfies the 40-story acceptance contract and every required branch through 71 successful Actual-backed assertion records. Combined coverage against `687088077b0fca9f826fc6c0300a37de2a88e68d` passes all overall and changed-file gates: workspace 90.19%, core protocol 95.69% overall / 95.21% changed, financial core 95.61%, binding 94.72%, and web 83.59% overall / 80.60% changed. Canonical coverage completed through staged full-package reruns after regression fixes, retaining genuine unchanged reports and instrumented native profiles; thresholds and exclusions were not relaxed. Production workspace build and affected final rebuilds, root/web type checks, zero-warning lint, Rust formatting and all-target/all-feature Clippy pass. Independent correctness and complexity reviews cover the complete feature, including the preserved partial implementation. Nix, Docker, future-dated ledger transfer execution and other-platform checks have not been verified in this executor.
