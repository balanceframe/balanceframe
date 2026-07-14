# Phase 8 — Budget intelligence

**Depends on:** trustworthy gateway, governance, and MVP evidence  
**Status:** Post-MVP

## Objective

Add explainable, conservative analysis: alerts, duplicate/anomaly and recurrence evidence, sinking-fund health, data-quality observations, reports, cash-flow context, and purchase evaluation. Begin analysis-only; advice is never permission or execution.

## Deliverables

### Financial truth and freshness

- Measure per account/provider authorization-to-posting delay, pending availability/ID stability, posting-description changes, duplicate pending/posting patterns, late posting, sync intervals, manual-entry frequency, and uncategorized exposure. These are observations; user policy decides risk.
- Apply explicit pending, uncleared, uncategorized, maximum bank-sync/snapshot-age, and account-override policy. If pending data is unavailable, never imply real-time completeness.
- Label each displayed amount/conclusion as **ledger fact**, **envelope availability**, **cash-flow projection**, **advice**, **proposal**, or **execution result**. Show account/date/pending/transfer/split/exclusion scope, assumptions, uncertainty, drill-down records, and why balances, availability, and forecasts differ.
- Keep Actual envelope availability authoritative for Actual-backed spending advice. Cash flow is a separately labelled projection; never add expected income to current availability.

### Insight and reporting surfaces

- Add spending alerts/watchlists, deterministic duplicate/anomaly evidence, recurring charges/subscription candidates, price/forgotten-service candidates, sinking-fund/target health, schedules, category status, reports, saved filters/views, and optional net-worth context.
- Findings carry evidence, correction/dismissal state, provider-independent export, and a concise next action. Recurrence is editable and may be marked not recurring. Do not claim cancellation or negotiate/change external services automatically.
- Keep one actionable home surface: attention items, data blockers, category/cash-flow risk, meaningful changes, target progress, then optional context—not a wall of charts.

### Notification policy and delivery

Deliver notifications only for actionable, policy-eligible events: data-quality incidents, alerts/watchlists, recurrence or duplicate findings, target/sinking-fund risks, approval requests, proposal expiry, and completed or failed consequential actions. A notification is an application delivery record, not evidence that its underlying financial conclusion is current; the originating finding, proposal, or execution result remains the authoritative, versioned object.

- Define deterministic notification policy per space and recipient scope: eligible event types and severities; recipient identities; permitted channels and approved messaging identities; destination verification state; maximum detail/redaction class; delivery windows/quiet hours; aggregation or digest behavior; rate/count limits; escalation; suppression/dismissal state; and current policy version.
- Re-authorize visibility at delivery time. A recipient must still have an active membership and the capability/scope to view the underlying record. Never disclose a private account, category, transaction, aggregate, linked-space projection, or proposal field merely because a destination was once configured.
- Treat all notification content and destinations as privacy-sensitive. Render content from structured, authorized facts; apply the current redaction policy before provider egress; use a provider/channel permitted for that exact delivery; and never transmit ledger credentials. Notification text, replies, webhooks, and provider callbacks are untrusted input and cannot authorize, approve, mutate, or expand access.
- Use an immutable outbox/delivery record containing the event identity/version, intended recipient, authorized field set or redaction class, channel/provider configuration version, policy version, canonical delivery/idempotency key, attempt history, provider acknowledgement or classified failure, suppression reason, timestamps, and correlation ID. Persist attempts before dispatch; retries reuse the same delivery key and must not create duplicate user-visible sends.
- Coalesce repeated events according to policy without losing the underlying event history. Acknowledging, dismissing, or suppressing a notification changes notification workflow state only; it never dismisses a financial blocker, consumes an approval, or changes a ledger record unless the user performs the separate authorized action.
- Channel/provider outages, rate limits, malformed callbacks, revoked destinations, privacy-policy denial, and delivery failure must become visible notification status. They fail only the affected delivery; they never block Actual synchronization, imports, manual review, deterministic analysis, proposal execution, or recovery. The product remains useful with every notification channel disabled.
- Keep notification delivery provider-neutral. Select at least one initial channel and its privacy defaults through an evidence-backed decision documented with the implementation; all channels use the same authorization, redaction, outbox, audit, and failure contract.

Every dispatch, suppression, acknowledgement, failure, retry, destination verification/revocation, and policy decision is attributable and auditable. Notification telemetry must not broaden the financial data egress allowed by the applicable provider and redaction policy.

### Purchase evaluation

Implement the deterministic `safe`, `safe_with_reallocation`, `not_safe`, and mandatory `insufficient_data` decision outcomes with reasons and evidence. Explicit policy covers requested category, current/future-month funds, pending/uncleared/uncategorized treatment, credit cards/payment categories, reimbursements/transfers/splits, protected funds, donors/minimum retained balances, cash buffer, approval requirement/expiry, and concurrent donor competition. Protected categories are configured by stable category ID, never hard-coded.

A model may explain reason codes in a configured tone but cannot alter decision facts.

### Decision data policy

```yaml
decisionDataPolicy:
  pendingTransactions: include | exclude | include_conservatively
  unclearedTransactions: include | exclude
  uncategorizedTransactions: block | reserve_full_amount | ignore
  maximumBankSyncAgeMinutes: 180
  maximumBudgetSnapshotAgeMinutes: 15
  accountOverrides:
    - accountId: "stable-ledger-id"
      pendingTransactions: include_conservatively
```

The user controls whether pending transactions affect advice. The system must report applied policy and observed limitations. If an institution does not expose pending transactions, the application must not imply complete real-time knowledge.

### Purchase decision type

```ts
type PurchaseDecision =
  | { outcome: "safe"; reasons: Reason[]; evidence: DecisionEvidence }
  | {
      outcome: "safe_with_reallocation";
      proposedReallocations: Reallocation[];
      reasons: Reason[];
      evidence: DecisionEvidence;
    }
  | { outcome: "not_safe"; reasons: Reason[]; evidence: DecisionEvidence }
  | {
      outcome: "insufficient_data";
      blockers: DataBlocker[];
      evidence: DecisionEvidence;
    };
```

`insufficient_data` is mandatory. Stale sync or material uncategorized exposure must not become a confident answer. The deterministic engine must explicitly define: advice versus authorization; requested category selection; pending and uncleared treatment; uncategorized exposure; current and future month funds; credit-card and payment-category behavior; reimbursements, transfers, and splits; protected categories; donor categories and minimum retained balances; cash safety buffer; approval requirements; proposal expiry; and concurrent proposals competing for the same funds.

### Tone separation

The deterministic result contains facts and reason codes. A model may render them in a configured tone, including blunt "bad guy" advice, but cannot alter the facts.

### Two complementary planning lenses

Support both without conflating them:

- **Envelope lens:** money currently available and assigned by category. Authoritative for Actual-backed spending advice.
- **Cash-flow lens:** expected income, bills, subscriptions, and projected balances. A projection with assumptions and uncertainty; never added to current availability.

### Financial-state labeling

Every displayed amount or conclusion must identify its semantic class:

- **ledger fact:** recorded in Actual;
- **envelope availability:** assigned and currently available by category;
- **cash-flow projection:** expected future result under stated assumptions;
- **advice:** deterministic recommendation under a policy version;
- **proposal:** exact prospective action awaiting authorization;
- **execution result:** confirmed mutation and resulting state.

Do not merge expected future income into current availability. Do not present advice as permission or execution. Do not publish totals without account, date, pending, transfer, split, and exclusion scope.

## Tests and exit

Scenario-test fully funded purchase, safe reallocation, protected funds, stale sync, large uncategorized exposure, pending policy, credit-card overspending, fixed bill early payment, sinking fund behind schedule, split/transfer/reimbursement/rollover consistency, duplicate ambiguity, and report scope/filter persistence.
Notification scenarios: authorized and unauthorized recipients; membership/capability revocation between enqueue and delivery; aggregate-only and redacted scopes; verified versus revoked destinations; quiet-hour, rate-limit, digest, escalation, and suppression precedence; duplicate event/retry/crash recovery; provider acknowledgement versus failure; malformed callback; channel/provider outage; all-channels-disabled operation; no ledger mutation from notification acknowledgement/reply; audit completeness; and web/CLI status parity.

**Exit:** deterministic scenarios confirm conservative analysis under stale, incomplete, duplicated, or ambiguously reconciled data; affected conclusions become visible `insufficient_data` blockers; and every notification is recipient-authorized, policy-redacted, idempotent, attributable, auditable, and independently failure-tolerant.