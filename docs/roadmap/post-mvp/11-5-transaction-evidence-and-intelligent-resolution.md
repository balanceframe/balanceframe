# Phase 11.5 — Transaction Evidence and Intelligent Resolution

**Depends on:** Phase 11 merchant intelligence and enrichment, Phase 8 data-quality/reconciliation analysis, Phase 8.8 financial decision and evidence foundation, Phase 8.6 Pre-Commitment Spending Intelligence, Phase 7 governance, and Phase 9 controlled mutation infrastructure  
**Status:** Post-MVP

## Objective

Build a generalized Transaction Evidence Layer that reconstructs an economic event from incomplete settlement observations, receipts, wallet activity, emails, user evidence, and Spend Sessions. It must prove how money moved before semantic categorization, create exact inspectable ledger-projection proposals, and ask users only when remaining ambiguity materially changes the ledger.

This is not isolated Venmo enrichment or Target receipt splitting. Payment intermediaries, mixed-category retailers, reimbursements, refunds, stored-value balances, and many-to-many settlement are one evidence-and-resolution domain.

## Decisions

- Actual remains authoritative for ledger and envelope facts. BalanceFrame stores immutable evidence, normalized observations, relationship candidates, workflow state, and projection proposals; it does not create a second general ledger.
- An observation is evidence, not automatically a transaction or fact. A settlement observation may be only one part of the underlying economic event.
- Monetary relationships are resolved deterministically before semantic classification. Models may interpret notes, descriptions, and product families but cannot establish financial identity, make amounts balance, select funding, or mutate Actual.
- The system supports one-to-one, one-to-many, many-to-one, and many-to-many matching. A source observation cannot be double-consumed except by explicit partial allocation.
- Every raw source, normalized observation, relationship, derived event, resolution, proposal, Actual write, and postcondition result has provenance, versioning, and audit visibility.
- Unknown balances, unmatched funds, unsupported source templates, receipt differences, and material ambiguity remain explicit. Do not invent opening balances, line items, reconciliations, or broad learned rules.
- All unresolved financial work enters the single prioritized exception inbox; never create permanent connector-specific queues.

## Deliverables

### Evidence foundation and economic-event graph

Persist immutable, deduplicated evidence documents and normalized financial observations with source identity, received/source timestamps, parser version, content hash, retention policy, parse status, and data-quality result. Keep encrypted raw content separate from normalized extraction; support configured deletion of raw content while retaining allowed hashes/provenance.

Model service-neutral observations and relationships for ledger transactions, wallet events/balances/transfers, receipts/orders/items/tenders, fees, refunds, spend-session items, and user corrections. Relationships include same-event, funding, partial funding, settlement, transfer, reimbursement, refund, reversal, supersession, containment, and corroboration; each has candidate/confirmed/rejected/superseded state, allocated amount, score, and reason codes.

Group evidence into versioned economic events: purchase, P2P payment, transfer, reimbursement, refund, fee, or mixed. Display the user-facing event and ledger consequence without requiring graph vocabulary.

### Deterministic matching and projection

Rust owns checked arithmetic, direction compatibility, amount conservation, duplicate/pending-to-posted analysis, wallet balance continuity, constrained many-to-many matching, receipt/tender/split validation, tax/discount allocation, candidate scoring, blockers, canonical projection planning/hashing, historical rule simulation, and Actual postcondition verification.

Matching considers stable external IDs when available, amount/direction compatibility, date windows and settlement delay, source reliability, pending state, event type, counterparty, statement corroboration, funding instrument, fees, and historical settlement behavior. A model never balances the graph.

TypeScript owns connector orchestration, source authentication, email/document ingestion, parsing/OCR coordination, policy, storage, review UX, Actual reads/writes, provider egress policy, and audit orchestration. Rust receives normalized inputs only; never raw mailbox messages, retailer HTML, or aggregator objects.

Every Actual mutation uses the ordinary authorization → current snapshot → immutable Rust plan/hash → write through adapter → Actual re-read → Rust postcondition → audit path. Stale, deleted, changed, duplicated, or mismatched records invalidate the proposal and require recomputation.

### Wallet and Venmo evidence

Implement a service-neutral `WalletEvidenceConnector` and a canonical internal wallet subledger. It records sent/received payments, requests, transfers, fees, refunds/reversals, funding, balance observations, and pending/completed state regardless of whether a visible Actual wallet account is needed.

For Venmo, use a limited mailbox connector or private inbound forwarding as the primary semantic source, with bank/card feeds as settlement evidence, aggregators as corroboration, and user-initiated statement import for backfill and repair. Request narrow access, deduplicate messages, validate sender/signature, version parsers, expose connector health, and never depend on consumer-credential scraping or an assumed public consumer API.

Infer projection automatically:

- collapse pass-through behavior into an enriched bank/card presentation only when deterministic evidence proves one-to-one zero-balance behavior;
- materialize an Actual wallet account when persistent stored value, aggregated funding, partial wallet funding, retained receipts, direct wallet spending, or equivalent behavior requires it;
- preserve stable materialization. Collapsing an already materialized account requires an explicit simulated migration.

Determine opening balance from an aggregator balance, statement ending balance, supported notification, or valid algebraic inference; otherwise use explicit `balance_unknown`. Block only conclusions that require the missing balance.

Resolve received wallet payments as reimbursement, repayment, rent contribution, refund, self-transfer, gift, business income, or income only from evidence. Received payment must not default to income; preserve links to reimbursed underlying expenses where supported.

### Retail and receipt evidence

Implement a service-neutral `RetailEvidenceConnector` that accepts approved delegated integrations when available, receipt/order emails, uploaded PDFs/screenshots, photos, and Spend Sessions. Do not use unauthorized retailer scraping or store credentials as the default solution.

Normalize receipt line items with raw/normalized description, SKU/UPC, department/product family, quantity, gross/discount/tax/net amounts, category/reimbursement/member suggestions, evidence strength, and reasons. Validate receipt totals and tender conservation exactly. Unknown differences remain explicit; never silently modify an item amount to force equality.

Support retailer order/receipt/invoice versioning, fulfillment groups, split shipments, card/bank/gift-card/reward tenders, discount and tax allocation, partial returns, refund matching, shared retailer accounts, member attribution, and spend-session reconciliation. Gift-card loading and gift-card spending are distinct financial events; gift-card tender is not a negative expense or free spending.

Apply a progressive categorization ladder: exact SKU/UPC rule, exact approved item, retailer mapping, department, product family, approved historical similarity, local semantic inference, larger model inference, then focused human review. Rules must contain sufficient context and undergo historical simulation plus approval before becoming deterministic. Ask only for unresolved material items, not a complete manual split.

### Health, privacy, and learning

Surface connector health and coverage: latest received/parsed evidence, parser-template changes, source/aggregator/bank freshness, statement coverage, unmatched activity, duplicate count, inferred missing events, and balance continuity. Source failure degrades only affected conclusions; Actual, manual review, and unrelated categorization remain usable.

Treat evidence as sensitive and untrusted. Encrypt raw content; use minimum retention; support deletion; redact data before permitted external inference; prevent private evidence from leaking across space scopes; and ensure document/mail content cannot invoke tools, change policy, or authorize an action.

Convert repeated approved outcomes into inspectable deterministic rule proposals. Show historical matches, conflicts, examples, source/account scope, false-positive risk, and interaction with Actual rules. The goal is lower model use and review volume, not opaque automatic behavior.

## Tests

Test valid/duplicate/malformed/changed-template wallet emails; statement backfill; limited aggregator fields; source conflicts; one-to-one, aggregate, partial-wallet, retained-balance, unknown-opening-balance, pending/posted, fee, refund, reversal, and ambiguous identical-amount wallet matching. Test reimbursements, rent, loan repayment, gift, income, self-transfer, shared obligations, and prompt injection in notes.

Test digital/PDF/screenshot/photo receipts; lines, quantities, discounts, taxes, missing lines, duplicate/updated invoices, split tenders, gift cards, rewards, settlement changes, multiple charges/orders, returns/refunds, shared-member attribution, receipt mismatch, spend-session substitution, and unknown item review. Test exact money conservation, stale proposals, retries, idempotency, postcondition mismatch, mutation authorization, privacy redaction, connector outage, all-models-disabled resolution, and rule simulation.

## Exit

**BalanceFrame can ingest multi-source evidence, reconstruct financially valid economic events, and produce exact authorized Actual projections without treating opaque settlements as the underlying purpose. Wallet transfers, reimbursements, receipts, tenders, returns, and splits conserve money; unresolved material ambiguity remains focused review work; and repeated approved behavior reduces future review without hidden automation.**

**See also:** [Merchant Intelligence and Enrichment](11-merchant-intelligence-and-enrichment.md), [Budget Intelligence](08-budget-intelligence.md), [Financial Decision and Evidence Foundation](08-8-financial-decision-and-evidence-foundation.md), [Pre-Commitment Spending Intelligence](08-6-pre-commitment-spending-intelligence.md), and [Controlled Reallocations](09-controlled-reallocations.md).
