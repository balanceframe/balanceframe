# ADR 0007 — Proposed operational delegation limits

Status: **proposed; owner decision required before implementation**.
Source baseline: main `6fe0c2d4075d841bdc45d9d12ecda2e7a24df265`.
No authorization, database, execution, provider or release behavior changes here.

## Existing boundary to preserve

Phase 7 already provides independent agent identities, versioned delegations,
issuer membership binding, resource restrictions, expiry, revocation, current
credential checks and human-controlled administration. `maxGrossOutgoing` and
`maxOperationCount` restrict one governed request; they are not durable calendar
budgets. Consequential assistance already distinguishes analysis, recommendations,
proposal creation and execution of independently approved actions.

Phase 9.5 must extend those services and the ordinary proposal/mutation path.
It must not create a second agent writer, inference authority or control plane.
The next implementation slices are operational controls, simulation and one
bounded rollout; this proposal separates the policy decisions they need.

## Decisions requested

### 1. First capability and execution authority

Recommended initial capability: categorization (`set_category`) on explicitly
selected accounts/categories. Exclude amount/date/identity changes, account
creation, receipt projections, transfers, wallet migrations, rule creation and
all control-plane authority.

Option A, recommended first: an attributable agent may schedule execution of
already independently approved exact categorization proposals. Keep every current
human quorum, expiry and payload rule. This adds bounded operation and owner
control without granting unattended model approval.

Option B, later: explicitly opt in to deterministic categorization without
per-operation human approval for a narrow approved rule/source domain. This needs
a new per-capability policy maximum and a separate reviewed authority transition.
A model's category suggestion never qualifies as deterministic proof. Do not infer
approval of option B from approval to implement limits or simulation.

### 2. Durable accounting semantics

Recommended: fixed **UTC calendar day, ISO week starting Monday, and calendar
month**, visibly labeled as UTC; all configured limits apply simultaneously.
Rolling windows avoid boundary bursts but need more complicated attribution and
query semantics. If household-local boundaries are required, decide that instead
before persisting the first policy version; do not silently use server local time.

Count each distinct planned transaction category write, including credits.
For a new cumulative magnitude limit, charge the **absolute canonical transaction
amount per currency**; never net incoming against outgoing or convert currencies.
Name it separately from existing `maxGrossOutgoing`, whose meaning must not change.
Every affected currency needs an explicit cap; absence denies that currency when
this magnitude policy is enabled. Owner selects actual limits; code invents none.

Use both a parent accounting scope `(space, budget, capability)` and a per-agent
scope `(space, budget, capability, agentId)`; per-currency magnitude counters add
the currency. All configured parent/agent caps intersect. Keep the same usage and
cooldown scope across policy/delegation versions and credential replacement;
parallel delegations share it. Lowering a cap below consumed usage blocks further
admission. A new agent does not reset its parent scope. Rejoining membership does
not revive old authority or erase prior usage.

Reserve count and magnitude atomically in the existing workflow SQLite store,
keyed by immutable proposal/effect identity. Attribute calendar windows at the
final durable dispatch-admission point. Rebook a queued, demonstrably unsubmitted
reservation atomically if its window changed; it cannot execute using yesterday's
allowance. Retries/replay reuse the original effect identity. Any uncertain
dispatch blocks further new admission in the affected accounting scopes until
authorized read-only recovery resolves it, even across a calendar rollover.
Verified effects stay charged to their admitted windows; release only on
authoritative proof of no dispatch. Policies, source versions, reservation
identity and audit attribution must be exportable. No new broker, service,
database or package is proposed.

### 3. Stop, revocation and cooldown

Recommended: human-reauthenticated global and per-agent stop, disabled automation
by default, and one durable dispatch-admission point serialized atomically with
stop/revocation and limit accounting before each external effect. If stop wins
first, deny admission. If admission wins first, disclose that handoff as potentially
in flight, including the interval before the Actual request is submitted. A stop
cannot undo that admitted handoff or an already submitted write. Retain uncertainty
and allow read-only recovery only under current independent read authority;
expired/revoked agent credentials gain no recovery exception. Never free the
budget or resend to make the UI appear complete.

A cooldown uses the last admitted dispatch/reservation, not the last successful
response; network failure cannot reset it. Revoked/expired identities cannot
create new proposals or dispatch old work. Re-enabling requires explicit human
control and does not revive expired authority or invalidate consumed accounting.

## Delivery and acceptance boundary after approval

1. Add only the chosen capability's append-only migrations, policy/control APIs,
   visible controls, durable admission/accounting and audit/export. Test concurrent
   contenders, time boundaries, credit/debit magnitude, currency mismatch, restart,
   stop/revoke races and uncertain partial dispatch before enabling a rollout.
2. Add read-only simulation over authorized current/historical canonical inputs.
   Bind its report to exact source, policy and delegation versions; expose excluded
   work, limits, cooldowns and blocker reasons. It neither reserves funds nor
   executes. Changed authority/source makes a saved preview stale.
3. Pilot only the approved execution option through current proposals, canonical
   Rust plans, current independent human approvals where required, Actual reread,
   postconditions, idempotency and immutable audit. Use disposable fixtures only.

All-models-disabled/manual review remains useful. Agents cannot stop, renew,
expand or approve their own authority. Real provider connection, external data
transmission, new dependencies and changes to financial approval semantics require
their own applicable approval; this ADR is not such approval.
