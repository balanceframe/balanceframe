# Phase 8.8 — Financial Decision and Evidence Foundation

**Depends on:** implemented Phase 8 budget intelligence, implemented Phase 8.5 web intelligence, and Phase 7 governance  
**Status:** Post-MVP

## Objective

Extend the implemented Phase 8 analysis and web baseline with the shared, versioned contracts required by Account-Aware Spendability, Pre-Commitment Spending Intelligence, and Transaction Evidence and Intelligent Resolution.

This phase intentionally does not implement Spend Sessions, reservations, wallet connectors, receipt parsing, backing allocation, transfer execution, or economic-event reconstruction. It makes their inputs, outputs, evidence, data quality, UI, notification, and authorization contracts coherent before those features add their domain workflows.

## Existing baseline

The branch already provides Phase 8/8.5 analysis and presentation foundations: deterministic purchase evaluation, cash-flow projection, data-quality and liquidity/obligation analysis, scenarios, findings, saved views, notifications, analysis APIs, and corresponding web routes/components. Preserve those public results where compatible. This phase is a controlled protocol evolution, not a second implementation of them.

## Deliverables

### Canonical financial analysis snapshot

Define one immutable, versioned normalized snapshot contract for deterministic financial decisions. It retains:

- stable ledger account, category, transaction, schedule, payee, and budget IDs;
- account type, on-budget state, currency, recorded balance, permitted visibility, and coverage;
- pending and uncleared activity plus policy treatment;
- schedules, obligations, date/range confidence, credit-card payment obligations, and transfer/reconciliation ambiguity;
- Actual snapshot time, per-account institution freshness, inclusion scope, policy version, correlation ID, and source-normalization version;
- explicit unknown, unavailable, stale, duplicate, incomplete, and currency-incompatible states.

TypeScript normalizes source-specific records into this contract. Rust consumes immutable normalized input only. The snapshot identifies facts and evidence; it does not itself assert account liquidity, category backing, or an economic-event resolution.

### Common decision, evidence, and data-quality vocabulary

Version canonical semantic classes, reason codes, blockers, evidence references, and remediation contracts shared across financial analysis. Extend existing labels to include account liquidity, reservation, commitment, source observation, normalized evidence, economic-event resolution, and redacted conclusion while preserving ledger fact, envelope availability, cash-flow projection, advice, proposal, and execution result.

Define explicit blockers for account freshness/coverage, pending availability, schedule coverage, duplicate/transfer ambiguity, credit-payment uncertainty, reservation conflict, wallet-balance uncertainty, receipt-total mismatch, economic-event ambiguity, and currency mismatch. Each blocker identifies affected scope, severity, whether it blocks or qualifies a conclusion, source evidence, remediation, snapshot ID, and policy version.

### Generic prospective claims input

Define immutable protocol inputs for commitments and reservations without implementing their workflow lifecycle here. Each item identifies source, stable scope, amount/currency, status, expiry/date range, visibility, and policy/snapshot version. Rust deterministically includes policy-eligible supplied claims in analysis and reports conflicts; Phase 8.6 owns commitment/reservation creation, lifecycle, and user experience.

### Reusable decision and presentation contract

Standardize a versioned result envelope for prospective financial decisions: request, snapshot/policy identity, readiness, semantic before/after state, reasons/blockers, authorized evidence references, alternatives, expiry, and redaction state. The envelope supports current Phase 8 purchase evaluation and later Decision Cards without requiring the current category-only response to become an incompatible ad-hoc API.

Extend shared web/CLI presentation contracts so `SemanticAmount`, `FreshnessBanner`, `ReasonCodeList`, `EvidenceDrawer`, `InsufficientDataPanel`, and attention findings can safely render the additional semantic classes, scope, redaction, remediation, and unknown codes. The presentation layer never calculates or fills in omitted financial facts.

### Notification and attention integration

Define policy-eligible finding and notification classifications for account-readiness blockers, transfer needs, reservation/commitment conflicts, evidence-connector degradation, and unresolved material evidence. Delivery remains a notification record—not proof that the underlying conclusion is current—and continues to re-authorize, redact, deduplicate, and fail independently.

All later financial exceptions use the existing prioritized attention surface and finding lifecycle. They must not create connector-, transfer-, receipt-, or session-specific permanent inboxes.

## Tests

Contract-test snapshot compatibility and stable IDs; per-account freshness/coverage; unknown versus empty configuration; pending/uncleared/scheduled/credit-card scope; currency mismatch; duplicate and transfer ambiguity; evidence redaction; blocker/reason-code forward compatibility; reservation/commitment conflict input; no-model operation; and equivalent web/CLI rendering of semantic classes, freshness, blockers, and remediation.

Regression-test existing Phase 8 analysis, findings, saved views, notifications, routes, and API outputs while introducing the versioned extensions.

## Exit

**All later financial-decision and evidence phases consume one immutable normalized snapshot and one shared vocabulary for financial state, provenance, redaction, readiness, blockers, reasons, attention findings, and notifications. Existing Phase 8 functionality remains compatible, and no later phase must invent a competing snapshot, data-quality, UI, or inbox contract.**

**See also:** [Budget Intelligence](08-budget-intelligence.md), [Web Budget Intelligence](08-5-web-budget-intelligence.md), [Account-Aware Spendability and Liquidity Routing](08-7-account-aware-spendability-and-liquidity-routing.md), [Pre-Commitment Spending Intelligence](08-6-pre-commitment-spending-intelligence.md), and [Transaction Evidence and Intelligent Resolution](11-5-transaction-evidence-and-intelligent-resolution.md).
