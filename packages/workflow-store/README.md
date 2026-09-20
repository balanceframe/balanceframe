# @balanceframe/workflow-store

Workflow persistence (SQLite).

Manages categorization review workflows and state transitions in a local SQLite database.

## Liquidity action specialization

`store.liquidity` extends the shared action proposals, approvals, idempotency and audit
records with immutable transfer previews, versioned policy/observations/preferences,
manual Spend Sessions and atomic claim effects. Trusted validators run synchronously
inside SQLite IMMEDIATE transactions against the current independent claim revision.
Native verification owns financial effects; `claimEffects:null` retains existing holds
and only confirmed settlement may release them.

`loadEvaluationState({actorId,budgetId,now})` returns sensitive server-only evaluation
inputs. It requires current effective conclusion membership and a granted resource,
not merely `observe`; application callers must separately authorize requested resources
and project every result. Expired supplemental records retain their version for editing
but must not be applied as current observations.
Payment preference management may request `includeExpired` to retain the version needed
for explicit CAS renewal; effective route selection excludes expired preferences.

`getTransferApprovalSummary` uses the application's trusted time without mutating
approvals through another clock. `cancelSpendSession` uses CAS/idempotency, preserves
session evidence and audit, and never releases initiated transfer holds.

The registered active owner provisions resource grants. The budget-only `full-read`
capability is an explicit privileged whole-budget disclosure permission for legacy
financial endpoints; nonowners also need `observe` and `liquidity:full-read` membership.
It does not imply source, proposal, approval, confirmation, or audit authority.
Owner discovery inserts only absent grants and never replaces explicit revocations.
Membership capabilities are initialized only on first provisioning; subsequent account
discovery preserves current membership capabilities and existing budget grants.
