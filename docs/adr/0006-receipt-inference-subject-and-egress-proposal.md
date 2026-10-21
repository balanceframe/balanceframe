# Receipt inference subjects and egress

Status: proposed; user approval required before implementation.

Phase 11.5 requests local semantic and larger-model categorization after exact
rules. The existing inference orchestrator requires an Actual transaction ID and
version. A receipt item has independent evidence identity and must not borrow or
fabricate an Actual identity to enter that path.

## Recommended decision

Extend the existing inference boundary with a distinct, typed receipt-item
subject, retaining the existing Actual-transaction subject unchanged. Receipt
inference remains disabled by default and optional. Missing models, failed
providers and denied egress always leave manual category selection available.
No new packages or mandatory infrastructure are proposed.

The server binds each candidate to current space/budget, actor/membership,
document ID/hash/parser, receipt/line identity, policy and category allowlist.
Requests and cache ownership cannot cross those boundaries. Source changes,
revocation and membership/policy changes invalidate pending suggestions.

Model-visible input is limited to explicitly permitted, redacted merchant/item
label, SKU/UPC, department and product-family context plus allowed category
labels/IDs. Exclude original images/text, document IDs, member identity, wallet or
account identifiers, payment details and monetary amounts. Treat labels as
untrusted data. Responses may suggest only an allowed category with provenance;
they cannot change quantities, amounts, funding, event identity, policy or Actual.
Higher deterministic tiers retain precedence.

Local and external inference need separate explicit authorization and provider
allowlists, minimized-payload preview and audit. External dispatch remains off
without the existing installation/space/budget opt-ins plus receipt-specific
egress authority. Approval of this ADR would authorize code and synthetic tests
only; it would not connect a provider or transmit real evidence.

## Alternatives and consequences

1. **Typed optional local and external receipt inference (recommended):**
   completes both semantic tiers while preserving separate source and egress
   authority. Adds a new subject contract, lifecycle tests and privacy controls.
2. **Typed local-only receipt inference:** reduces external-privacy scope, but
   still requires the new subject and leaves larger-model acceptance deferred.
3. **Defer receipt inference:** keeps the complete deterministic ladder and
   focused manual review; both semantic tiers remain an explicit scope gap.

## Acceptance if approved

- Genuine receipt identities only; forged Actual identities and caller-authored
  authority are rejected.
- Every source, membership, policy, allowlist, consent and payload-hash fence is
  rechecked after asynchronous provider work.
- Synthetic tests prove no dispatch by default or on denied/expired authority,
  minimized redacted payloads, source-scoped cache ownership, prompt-injection
  containment, invalid response refusal and graceful manual fallback.
- No model establishes financial identity, repairs conservation, selects a
  settlement, broadens a rule or writes Actual.
