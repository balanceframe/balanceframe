# @balanceframe/web

BalanceFrame web frontend — responsive review surface for transaction categorization.

## Architecture

The review surface is a **framework-neutral TypeScript controller** (`ReviewController` in `src/review.ts`) that consumes the shared `@balanceframe/workflow-store` persistence contract without duplicating it. It is designed to be adapted by any UI layer (React, Vue, Svelte, etc.) through state subscriptions and action bindings.

### Key components

- **ReviewController** — manages a priority-sorted attention queue, handles item navigation, selection, single-item actions (approve/correct/reject/skip/undo), and bulk operations with homogeneity verification.
- **ReviewActionBindings** — a uniform interface for keyboard shortcuts and touch gestures. Every action has identical semantics regardless of input modality.
- **ReviewMetricsCollector** — deterministic metrics for median review time, acceptance/correction/rejection rates, interaction counts, backlog age, coverage, latency, recurrence, and duplicates avoided.
- **ReviewSurfaceState** — immutable snapshot emitted on every change. UI layers subscribe via `controller.subscribe()`.

### Review lifecycle

The controller maps the lifecycle from `@balanceframe/workflow-store`:
- Items are loaded from the store in priority order (highest first).
- Actions transition items through the lifecycle: `pending_review → approved | correcting | rejected | skipped`.
- The queue advances immediately after each action (immediate progression).
- Bulk operations require homogeneous status and category; heterogeneous selections are rejected with a clear conflict reason.
- Reversible transitions (`approved → pending_review`, `correcting → pending_review`) are exposed via undo.
- Terminal items (`applied`, `rejected`, `skipped`, `superseded`) are excluded from the attention queue.

### Evidence model

Each queue item carries rich evidence derived from the stored suggestion and review-item payload:

| Field | Source |
|---|---|
| `originalImportedName` | Suggestion payload or transaction ID |
| `normalizedMerchant` | Suggestion payload or transaction ID |
| `account` | Suggestion payload |
| `amount` | Suggestion payload |
| `currentCategory` | Current category from evidence |
| `suggestedCategory` | Review item's category ID |
| `alternatives` | Alternative categories from classifier |
| `history` | Prior approved classifications |
| `provenance` | Review item provenance |
| `freshness` | Freshness expiry timestamp |
| `changePreview` | Computed diff between current and suggested |

External enrichment (e.g. from a ledger connection) can be injected via the `enrichEvidence` config callback.

### Test coverage

Tests cover: keyboard/touch parity, priority ordering, evidence visibility, heterogeneity rejection for bulk actions, undo consistency, inaccessible provider errors, model-disabled review states, duplicate attention prevention, metrics collection, and immediate progression.
