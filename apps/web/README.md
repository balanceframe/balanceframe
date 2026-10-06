# @balanceframe/web

BalanceFrame web frontend — responsive review surface for transaction categorization.

## Authenticated spaces and approvals

Sign in with an independent account and explicitly select a space in the header.
`/spaces` manages membership periods, exact grants, policy versions, agents,
delegations, credential bindings, connection scope, and scoped audit history.
Creating a space does not select or bind an Actual budget. Control changes require
fresh confirmation with the current account's password; credentials are never shared
with another member or delegated agent.

`/connection` requires password confirmation before discovering Actual budgets;
`/connection` and `/spaces` leave discovered budgets unselected until you choose
the intended budget. `/liquidity/settings` confirms the
current human before saving policy, user-attested observations, or resource grants.
Failed confirmation prevents the write, and submitted password fields are cleared.
The grant editor sends only edited rows, leaving unrelated governance grants intact.

Source derives identity from the verified session or live bound API credential, not
request-body actor IDs. Every route uses current selected-space authority. Narrowed
or aggregate-only grants do not permit a whole raw ledger; field-level projections
withhold independently restricted account and evidence data.

Review approval/correction creates an exact pending proposal rather than applying
a financial change immediately. The proposal review displays its operation, payload
hash, requester, policy versions, expiry, required approvers, and current approvals.
Each approval binds the displayed hash and requires fresh human authentication.
Execution remains separate and requires the current quorum and executor rights.
The review is finalized only after Native verifies the actual ledger result.

Use the disposable Actual fixture for browser verification and disable the development
authentication bypass. A component test or successful API request alone does not
verify the signed-in user path.

### Local merchant evidence

The existing `/review` surface includes an expandable merchant evidence and observed
patterns panel, including patterns from already categorized transactions. Loading and
refreshing it rechecks current selected-space source authority; failed refreshes clear
the old evidence. Raw field availability is distinct from normalized text. Evidence
tiers are uncalibrated, confirmation records human intent, and neither alias nor
pattern decisions execute a financial write.

Private/shared alias and pattern decisions require explicit password confirmation and
the server's current evidence revision and decision version. Targets are exact Actual
payee IDs. Rejection remains a persisted decision, not a client-only dismissal.
Observed ranges, exact rational variance, civil dates, full distributions, bounded
samples, source coverage, expiry and versions are shown separately from schedules.
Money uses its currency exponent without converting large minor-unit strings to floats.

Merchant policy and calendar controls are on the existing Rules surface. Jurisdiction,
subdivision and IANA time zone are explicit; no locale or currency inference is used.
Policy saves replace the complete authorized policy, preserving all account overrides;
an unauthorized full read disables editing instead of overwriting hidden settings.
Provider mode defaults to local-only/off, and billing quotas are separate from source
transaction currencies. An external-allowed setting is not research consent: external
dispatch is not part of these local controls and requires a separate authorized egress
action. Sync never waits for a provider.

Native rule review shows the exact stable-ID Actual payload, complete reviewed
simulation and conflicts, and global future scope. Category differences are paged
100 rows at a time without truncating the full reviewed IDs or simulation data.
A standalone JSON download exports the native rule, not a BalanceFrame proposal
wrapper. Approval and execution remain separate.

## Architecture

The review surface is a **framework-neutral TypeScript controller** (`ReviewController` in `src/review.ts`) that consumes the shared `@balanceframe/workflow-store` persistence contract without duplicating it. It is designed to be adapted by any UI layer (React, Vue, Svelte, etc.) through state subscriptions and action bindings.

### Key components

- **ReviewController** — manages a priority-sorted attention queue, handles item navigation, selection, single-item actions (approve/correct/reject/skip/undo), and bulk operations with homogeneity verification.
- **ReviewActionBindings** — a uniform interface for keyboard shortcuts and touch gestures. Every action has identical semantics regardless of input modality.
- **ReviewMetricsCollector** — deterministic metrics for median review time, acceptance/correction/rejection rates, interaction counts, backlog age, coverage, latency, recurrence, and duplicates avoided.
- **ReviewSurfaceState** — immutable snapshot emitted on every change. UI layers subscribe via `controller.subscribe()`.

### Review lifecycle

The framework-neutral controller maps the persisted lifecycle below. The authenticated
Source adapter keeps financial reviews pending while their proposals await approval
and execution; creating or approving a proposal does not apply these terminal transitions.
  - Items are loaded from the store in priority order (highest first).
  - Actions transition items through the lifecycle: `pending_review → approved | correcting | rejected | skipped`.
  - The queue advances immediately after each action (immediate progression).
  - Bulk operations require homogeneous status and category; heterogeneous selections are rejected with a clear conflict reason.
  - Reversible transitions (`approved → pending_review`, `correcting → pending_review`) are exposed via undo.
  - Terminal items (`applied`, `apply_failed`, `rejected`, `skipped`, `superseded`) are excluded from the attention queue.
  - **apply_failed**: items where the apply-to-ledger step errored. These remain in the store for failure forensics and manual re-processing; the controller does not surface them automatically. Downstream systems should inspect `apply_failed` items separately via direct store queries.

### Evidence model

Each queue item is projected from current independently authorized native source facts
and freshly governed merchant evidence. Stored classifier JSON is not source authority.

| Field | Source |
|---|---|
| `originalImportedName` | Authorized native source text; explicit availability lives in merchant evidence |
| `normalizedMerchant` | Current native display name or authorized normalized evidence |
| `account` | Current authorized account name, otherwise restricted |
| `money` | Exact canonical native Money, with its source currency |
| `amount` | Optional legacy display value; never used for merchant calculations |
| `currentCategory` | Current authorized native category |
| `suggestedCategory` | Review item's admitted proposed category ID |
| `alternatives` / `history` | Authorized evidence; bounded samples are not full aggregates |
| `provenance` | Actual source/evidence producer metadata |
| `freshness` | Current evidence expiry |
| `merchantEvidence` | Typed current governed suggestion with raw availability and revision |
| `changePreview` | Difference between current and proposed category |

Alias/pattern decisions and policy settings are persisted through the governed merchant
API; the UI does not inject provider results or grant evidence access.

### Test coverage

Tests cover: keyboard/touch parity, priority ordering, evidence visibility, heterogeneity rejection for bulk actions, undo consistency, inaccessible provider errors, model-disabled review states, duplicate attention prevention, metrics collection, and immediate progression.
