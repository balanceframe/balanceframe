# Phase 5 — Deterministic learning

**Depends on:** Phase 4  
**Status:** Upcoming

## Objective

Convert repeated, human-confirmed categorization behavior into transparent deterministic Actual rules so the review queue, model calls, token cost, and recurring correction rate decline over time.

```text
new ambiguity → suggestion → human approval/correction → repeated consistent outcome
→ rule proposal → historical simulation → explicit approval → Actual rule
→ future import handled without model inference
```

## Deliverables

### Evidence and proposal generation

- Rust normalizes merchants and analyzes approved history using stable category IDs, account, direction, amount/date patterns, imported payee, and other context. Category display names never anchor policy.
- Generate rule candidates only from sufficient consistent evidence. Merchant-only matching is not automatically adequate when account, amount, direction, or date differentiates behavior.
- Rust historically simulates every rule proposal and returns matches, category distribution, conflicts, account/amount/date range, examples, existing-rule overlap, stage/precedence, and predicted future affected imports.
- Surface recurrence/merchant corrections as inspectable evidence. A user can mark a recurrence as not recurring; no model silently learns or creates a category/rule.

### Approval, execution, and control

- Present the simulation through the same proposal/approval/mutation pipeline. Rule creation always requires explicit approval in the MVP.
- TypeScript translates only an approved Rust rule plan into Actual, tracks Actual rule IDs, resulting behavior/performance, precedence, and execution provenance.
- Every BalanceFrame-created rule is inspectable, editable, disableable, reversible where Actual permits, attributable, exportable, and safely removable. Explain why it matched and what it changed.
- Keep Actual's own rule behavior authoritative; test its automatic learning and precedence rather than duplicating it. Do not create a competing classifier or opaque learning layer.

### Manual entry and reconciliation preservation

Manual entry is first-class. Reuse Actual `importTransactions` for bank-like imports because it runs import rules, deduplicates `imported_id`, and attempts amount/date/payee matching; do not use `addTransactions` for bank imports. Dry run when possible, observe added/updated IDs, preserve categories, notes, splits, reimbursement state, and linked-space references, and surface unresolved duplicate/merge ambiguity as concise review.

Never silently double-count, silently merge ambiguous records, assume imported data wins every field, require users to understand FITIDs/import overlap, or let a model choose transaction identity. Explain reconciliation winners and field-level enrichment.

## Measurement and tests

Report deterministic coverage, rules created, historical matches/conflicts, repeated corrections eliminated, model calls avoided, backlog age, and model cost. Test rule precedence/overlap, account/amount/direction context, deleted/changed category, rule rollback, manual/import reconciliation exact matches, date shift, payee change, repeated amount, different merchant, split, transfer, pending-to-posted, refunds, deleted imports, duplicate IDs, and rule-normalized payees.

## Exit

**Recurring categorization work and model use demonstrably decline while rules remain understandable, reversible where possible, and under explicit user control.**