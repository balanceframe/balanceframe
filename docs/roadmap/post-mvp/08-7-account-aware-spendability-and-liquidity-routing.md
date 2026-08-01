# Phase 8.7 — Account-Aware Spendability and Liquidity Routing

**Depends on:** Phase 8 budget intelligence, Phase 8.5 web intelligence, Phase 8.8 canonical financial snapshot contract, and Phase 7 governance  
**Status:** Post-MVP

## Objective

Make payment-account readiness a first-class, deterministic financial result. BalanceFrame must tell a user separately whether a purchase is funded by its category and whether the selected payment account can safely settle it, including an alternate payment route or exact transfer need when available.

The user-facing capability is **Account-Aware Spendability**. The internal domain capability is **Liquidity Routing**. It is a current derived backing plan, not permanent dollar provenance and not a replacement ledger.

## Decisions

- Budget funding and payment-account liquidity are distinct. A funded category is not described as ready from an account that cannot safely settle the purchase.
- Every purchase evaluation names an explicit payment account or reports that none was selected. Resolution order is explicit user choice, Spend Session/payment-method selection, approved merchant/category preference, deterministic historical route, then alternatives.
- Category reassignment does not move bank cash. An on-budget transfer does not change category assignments and is neither income nor spending.
- BalanceFrame tracks current category backing across eligible accounts; it does not claim permanent penny-level provenance. A category may be backed by multiple accounts.
- Displayed balance is not safe additional spending. Safe capacity reserves policy-eligible pending/uncleared activity, scheduled obligations, credit-card payments, protected buffers, holds/restrictions, and active proposal reservations over a disclosed horizon.
- Expected income is projection-only unless a separately disclosed policy permits it before settlement; it never increases current availability or liquidity silently.
- Stale, incomplete, ambiguous, unauthorized, or currency-incompatible evidence produces `insufficient_data`; it never produces a confident transfer or payment recommendation.
- Models may explain immutable reason codes. They may not calculate liquidity, select funds, authorize, initiate, or verify transfers.

## Deliverables

### Normalized liquidity inputs and data quality

Preserve stable account IDs, account type/on-budget state, roles, currency, balance coverage, pending and uncleared state, schedules, credit-card payment obligations, institution freshness, transfer timing, account visibility, and policy version throughout the protocol.

Normalize facts before the Rust boundary. Record snapshot timestamp, institution sync time per account, pending/uncleared inclusion, schedule coverage, duplicate/transfer ambiguity, account coverage, and applied policy. Raw Actual/provider objects never enter the financial core.

Define account roles: `daily_spending`, `bill_payment`, `reserve`, `savings`, `restricted`, `credit_payment`, `cash`, and `excluded`. Roles and account policy control protected buffers, transfer-source/payment eligibility, expected delay, same-day availability, cutoff/weekend behavior, ordinary-category backing, automation eligibility, and resource scopes.

### Safe capacity and backing allocation

Rust calculates account safe additional spending capacity and safe transferable excess for a specific evaluation horizon. The calculation must retain every subtraction as evidence and reason code.

Maintain a versioned, reproducible category-to-account backing allocation using nonnegative values and immutable snapshot/policy inputs. It must enforce:

- applicable category backing totals equal authoritative category availability;
- account backing never exceeds eligible backing capacity;
- account/category eligibility, currency, account-role, restricted-fund, ownership, authorization, and protected-reserve constraints;
- no credit account as cash backing and no off-budget account unless an explicit later policy permits it;
- special handling for negative/overspent, future-month, transfer-like, reimbursement, debt, and credit-card payment categories;
- stability: preserve prior valid allocations when feasible rather than churn backing assignments.

When no feasible plan exists, return explicit reasons such as insufficient cash backing, stale data, restricted funds, overcommitted schedules, unresolved transfer, credit-payment underfunding, incomplete coverage, or currency mismatch. Never invent an allocation.

### Payment routing and spendability decision

For each purchase, produce independent `BudgetFundingStatus` and `PaymentLiquidityStatus` outputs. Payment status is `ready`, `use_other_account`, `transfer_required`, `transfer_too_late`, `not_liquid`, or `insufficient_data`.

Return selected-account safe capacity before/after purchase, preferred and alternative routes, required transfer(s), timing, protected-buffer effects, reasons, data quality, and snapshot/policy identifiers. The UI must separately show budget effect, account effect, transfer effect, timing, assumptions, freshness, and uncertainty.

Integrate results into category views, account views, category-reallocation previews, purchase checks, Spend Sessions, and the unified attention surface. Do not create a permanent transfer inbox.

### Credit-card semantics

A credit-card evaluation checks category funding, authorization capacity, payment-cash reservation, expected payment account, and that account’s safe capacity by due date. Do not reject a valid card purchase merely because checking cannot settle it immediately; do not approve it while ignoring future payment liquidity; do not treat card credit as cash backing or double-count card payment reserves.

### Read-only transfer planning

For a selected cash account, calculate the exact minimum transfer shortfall and eligible source-account safe transferable excess. A proposal may include a separately labeled recommended convenience amount, but the minimum amount, source/destination effects, timing, policy assumptions, and reasons remain explicit.

Read-only output includes exact source/destination, minimum and optional recommended amounts, required-by time, estimated arrival, source/destination preconditions, snapshot ID, policy version, payload hash, expiry, and competing-proposal reservations. It does not initiate a bank transfer.

### Controlled transfer workflow

Extend the Phase 9 consequential-action pipeline with transfer-specific workflow state: need detected, proposed, awaiting approval, approved, user action required, user-reported initiated, source observed, destination observed, reconciled, and confirmed. Include expiry, supersession, cancellation, source insufficiency, delay, one-sided import, amount mismatch, duplicate candidate, and reconciliation-required outcomes.

A recorded Actual transfer or user acknowledgement is not bank settlement. Confirm only with deterministic evidence such as both imported/reconciled sides or a trusted provider confirmation that agrees with Actual. Initial workflow provides instructions/deep links where practical and import matching; direct provider initiation is explicitly out of scope until separate operational, security, legal, and provider-capability review.

### Privacy and authorization

Authorization governs account/category visibility, balance detail, proposal visibility, approval, initiation, confirmation, and audit. A redacted result may state that an authorized holder must transfer an exact amount without exposing the private source account or balance. Hidden values never enter a model prompt merely to create an explanation.

## Tests

Scenario-test multi-checking and savings accounts, restricted/off-budget/negative/disconnected accounts, stale and missing coverage, pending/uncleared changes, scheduled bills before income, protected buffers, expected-income exclusion, currency mismatch, funding in one account with spending from another, account-route override, same-day/external/weekend transfer timing, competing purchases/proposals, source changes after approval, partial/duplicate/reversed transfer imports, and category reallocations that do not move cash.

Test card capacity, payment cash, due-date liquidity, multiple cards sharing a payment account, refunds, scheduled autopay, and pending card activity. Test authorization/redaction, deterministic repeatability from the same snapshot and policy, no-model operation, immutable proposal hashes, expiry, stale preconditions, idempotency, postcondition verification, and non-settlement of single-sided or ledger-only transfers.

## Exit

**A category may be funded while its selected payment account is correctly reported not ready; users receive a policy-backed alternate route or exact minimum transfer when evidence permits. Calculations protect account buffers and obligations, never conflate category moves with bank cash movement, preserve privacy, and block affected conclusions on insufficient data.**

**See also:** [Budget Intelligence](08-budget-intelligence.md), [Financial Decision and Evidence Foundation](08-8-financial-decision-and-evidence-foundation.md), [Pre-Commitment Spending Intelligence](08-6-pre-commitment-spending-intelligence.md), [Controlled Reallocations](09-controlled-reallocations.md), and [Space Governance](07-space-governance.md).
