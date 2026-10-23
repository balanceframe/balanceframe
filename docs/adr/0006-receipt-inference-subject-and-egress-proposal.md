# Receipt inference subjects and egress

Status: accepted for application code and synthetic tests; provider connections,
enabling inference, real-data transmission, packages and publication remain outside
this approval.

Phase 11.5 requests local semantic and larger-model categorization after exact
rules. The existing inference orchestrator requires an Actual transaction ID and
version. A receipt item has independent evidence identity and must not borrow or
fabricate an Actual identity to enter that path.

## Accepted decision

Extend the existing inference boundary with a distinct, typed receipt-item
subject, retaining the existing Actual-transaction subject unchanged. Receipt
inference remains disabled by default and optional. Missing models, failed
providers and denied egress always leave manual category selection available.
No new packages or mandatory infrastructure are proposed.

The server binds each candidate to current space/budget, actor/membership,
document ID/hash/parser, receipt/line identity, policy and category allowlist.
Requests and cache ownership cannot cross those boundaries. Source changes,
revocation and membership/policy changes invalidate pending suggestions.

Model-visible input is limited to a permitted item label and authorized category
labels with per-preview opaque aliases. Real category IDs stay server-side. The
initial contract omits merchant/department/product-family context and SKU/UPC;
deterministic rules already use that context without disclosure. Exclude original images/text, document IDs, member identity, wallet or
account identifiers, payment details and monetary amounts. Treat labels as
untrusted data. Responses may suggest only an allowed category with provenance;
they cannot change quantities, amounts, funding, event identity, policy or Actual.
Higher deterministic tiers retain precedence.

Local and external inference need separate explicit authorization and provider
allowlists, minimized-payload preview and audit. External dispatch remains off
without the existing installation/space/budget opt-ins plus receipt-specific
egress authority. Approval authorizes code and synthetic tests
only; it does not connect a provider or transmit real evidence.

## Alternatives and consequences

1. **Typed optional local and external receipt inference (recommended):**
   completes both semantic tiers while preserving separate source and egress
   authority. Adds a new subject contract, lifecycle tests and privacy controls.
2. **Typed local-only receipt inference:** reduces external-privacy scope, but
   still requires the new subject and leaves larger-model acceptance deferred.
3. **Defer receipt inference:** keeps the complete deterministic ladder and
   focused manual review; both semantic tiers remain an explicit scope gap.

## Acceptance

- Genuine receipt identities only; forged Actual identities and caller-authored
  authority are rejected.
- Every source, membership, policy, allowlist, consent and payload-hash fence is
  rechecked after asynchronous provider work.
- Synthetic tests prove no dispatch by default or on denied/expired authority,
  minimized redacted payloads, source-scoped cache ownership, prompt-injection
  containment, invalid response refusal and graceful manual fallback.
- No model establishes financial identity, repairs conservation, selects a
  settlement, broadens a rule or writes Actual.

## Implementation boundary

The additive receipt contract does not reuse transaction classification requests.
Installation configuration and the provider registry are trusted composition inputs;
web composition supplies neither. Missing installation, space or budget opt-ins
keep both inference paths unavailable. Local and external execution use distinct
`receipt-inference:local` and `receipt-inference:external` capabilities. Policy
changes require `receipt-inference:policy:manage` on the relevant space or budget
and fresh human review. Existing merchant research consent grants no receipt egress.

The current conservative sanitizer accepts only bounded plain labels, rejects
instruction patterns and known sensitive values, and refuses unsupported labels
instead of sending extra context. It applies equally to local and external input.
It does not guarantee anonymization; the human preview displays the exact payload.
No production receipt transport or credentials are registered.

Consent previews expire after five minutes and are single-use. The journal stores
source/binding/payload hashes, opaque alias mappings and provider provenance, never
labels or raw provider text. SQLite reserves daily limits across actors at the
installation, space and budget layers before dispatch. Unknown outcomes retain the
reservation. Dispatch guards run after adapter preparation and results are checked
again before publication. Restore/deletion cannot recreate a removed live dispatch.
A cache hit still requires current source, membership, policy, categories, provider
configuration and consent; withdrawal suppresses reuse. Audit exports contain only
content-free state/provenance metadata.

Deterministic rules always run first. Conflicts remain manual. A usable authorized
local result prevents escalation until explicitly rejected; local failure does not
send an external request. External preview and fresh consent remain separate.
Selecting a returned category only fills the existing human review control. It
never creates a learning outcome or a financial action.
