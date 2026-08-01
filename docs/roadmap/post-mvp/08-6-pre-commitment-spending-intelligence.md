# Phase 8.6 — Pre-Commitment Spending Intelligence

**Depends on:** Phase 8 budget intelligence, Phase 8.5 web intelligence, Phase 8.8 financial decision and evidence foundation, Phase 7 governance, and the read-only portion of Phase 8.7 account-aware spendability  
**Status:** Post-MVP

## Objective

Make the consequences of a proposed purchase visible before payment. A deterministic Decision Card evaluates category funding, commitments, reservations, payment-account readiness, policy constraints, and data quality; a Spend Session applies the same analysis to a temporary cart or multi-item purchase.

This phase is read-first. Advice, reservations, and scenarios are BalanceFrame workflow state, not Actual transactions. Any later reallocation or transaction write remains subject to the Phase 9 proposal, approval, execution, re-read, and postcondition-verification pipeline.

## Decisions

- A purchase result is never an ambiguous affordability boolean. It is one of `funded_now`, `safe_with_reallocation`, `safe_after_date`, `cash_available_but_unfunded`, `plan_breaking`, `not_safe`, or `insufficient_data`.
- Envelope funding and payment-account liquidity are separate results. This phase consumes the canonical account-aware result from Phase 8.7; it does not implement a competing account-backing model.
- Category availability is not surplus. Commitments, active reservations, projected remaining need, protected-category rules, and donor policy determine what can safely be redirected.
- Expected income is a disclosed projection, never current availability.
- Models may parse typed requests, explain deterministic reason codes, and offer optional coaching. They never calculate totals, choose funding, override data blockers, authorize a mutation, or claim success.
- Guilt-free and intentionally discretionary categories are valid policy constructs. Fully funded spending from them should be affirmed, not discouraged.

## Deliverables

### Canonical Decision Card

Implement a versioned immutable Decision Card containing the proposed purchase, normalized snapshot and policy versions, readiness, outcome, before/after financial state, funding paths, opportunity costs, conflicts, authorization requirements, evidence, freshness, and expiry.

Every card must expose:

- category availability, commitments, reservations, uncommitted availability, and safe-to-redirect amount;
- selected payment account and account-aware status;
- affected goals, protected categories, recurring obligations, and spending runway;
- exact funding paths and their reallocations, timing, approvals, and tradeoffs;
- snapshot coverage, pending policy, stale-data blockers, and assumptions.

`insufficient_data` is mandatory whenever material ledger, account, currency, reservation, duplicate, transfer, or schedule evidence is stale, missing, ambiguous, or inconsistent.

### Deterministic purchase and scenario analysis

Rust owns checked money arithmetic, readiness, category and account analysis, commitment/reservation effects, runway, protected-category enforcement, funding-path generation, goal impact, competing-proposal detection, priority-based cart trim options, canonical plans, hashes, and postconditions. Inputs are normalized immutable protocol snapshots; raw Actual and provider objects never enter the core.

TypeScript owns Actual synchronization, normalization, policy and workflow persistence, UI/CLI, authorization, provider orchestration, and approved mutation execution. Actual remains authoritative for accounts, transactions, categories, schedules, assignments, splits, transfers, and reconciliation.

Support quick one-number checks, multiple proposed purchases, and recurring-commitment evaluation. Evaluate decisions jointly when they compete for the same donor funds, category availability, or account capacity; individually safe proposals must not be presented as jointly safe without proof.

### Spend Session

Implement an optional, temporary session for a list-based or unstructured purchase. It supports manual items/prices, quantity, required/planned/optional priority, category splits, user-entered tax/fee/discount assumptions, running total, warning thresholds, cart-trim alternatives, final total, and expiration.

A barcode identifies a product, not an authoritative current price. Any non-current-session price must identify its source, store when known, observation time, and estimate status. Barcode lookup, retailer data, receipt capture, and external research remain optional integrations; the session is useful with only manual entry.

Warnings must state the concrete threshold, financial effect, and alternatives. Cart trimming must prefer optional items over planned or required items, preserve taxes and fees, offer alternatives rather than remove items automatically, and never use model arithmetic.

### Commitments, reservations, and cooldowns

Create explicit BalanceFrame-side records for commitments and reservations. They are visibly distinct from ledger transactions, Actual schedules, forecasts, approved proposals, and completed spending.

Reservations have a source, category/account scope, exact amount, state, expiry, actor, policy version, and audit trail. Authorized members see their impact; expiry/release/consumption restores availability deterministically. Policies decide whether reservations merely inform or block competing decisions.

Support optional cooldowns for qualifying discretionary decisions. Re-evaluate the exact card after the configured interval; changed snapshot, cart, account, category, or funding path invalidates the prior proposal/approval.

### Completion and reconciliation

A completed session may create an approved manual Actual transaction or split through the ordinary mutation pipeline. Preserve user-correctable item/split intent, then use Actual’s reconciliation for later imports. Link session, proposal, manual transaction, imported transaction, and ambiguous-match review without creating a competing ledger merge system or silently double-counting.

## Tests

Scenario-test funded, underfunded, protected, joy-category, stale, currency-mismatch, pending, uncategorized, reservation-conflict, commitment-overlap, credit-card, account-shortfall, donor-conflict, future-date, and multi-purchase cases. Test cart quantity/add/remove, tax/fee/discount thresholds, required-item overage, expiration, price provenance, shared visibility/redaction, changed-cart approval invalidation, split correction, import-before-completion, ambiguous reconciliation, crash retry, and all-models-disabled operation.

## Exit

**A user can evaluate a purchase or active cart and understand the exact before-and-after plan, payment-account readiness, evidence freshness, and valid alternatives without creating a ledger mutation or relying on a model for financial authority. Competing commitments, reservations, and proposals cannot silently reuse the same funds.**

**See also:** [Budget Intelligence](08-budget-intelligence.md), [Web Budget Intelligence](08-5-web-budget-intelligence.md), [Financial Decision and Evidence Foundation](08-8-financial-decision-and-evidence-foundation.md), [Account-Aware Spendability and Liquidity Routing](08-7-account-aware-spendability-and-liquidity-routing.md), [Controlled Reallocations](09-controlled-reallocations.md), and [Transaction Evidence and Intelligent Resolution](11-5-transaction-evidence-and-intelligent-resolution.md).
