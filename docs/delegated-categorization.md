# Bounded delegated categorization

This first operational capability uses the existing categorization writer.
It does **not** remove independent human approvals, create model authority,
initiate transfers, change amounts or add an agent-specific mutation path.
An agent must still have its own live credential, exact delegation and source/
account/category grants. Human membership and all current approval requirements
are checked again before dispatch.

## Explicit controls

In **Spaces → Categorization automation limits**, use fresh human confirmation
to configure both the shared parent scope and each selected agent. Both are
absent/disabled by default. Enabling a scope does not issue a credential or grant
any resource access. Limits intersect with existing narrower delegation/grant
restrictions. Management requires `delegation:manage`; agents cannot configure
these controls or approve their own financial work.

Each enabled scope needs at least one UTC calendar cap. For example, this
**fictional configuration**, not an installed default, permits at most two
category writes and USD 100 minor units of affected transaction magnitude per day:

```json
[{"window":"day","maxOperations":2,"maxMagnitude":[{"currency":"USD","minorUnits":"100"}]}]
```

Windows are `day`, ISO `week` starting Monday, or calendar `month`. All configured
windows apply. UTC calendar boundaries can permit work on both sides of a
boundary; these are not rolling-window limits. Magnitude uses the absolute
canonical amount of the one transaction actually categorized, including credits;
incoming and outgoing amounts never net. Currencies need independent explicit
caps and are never converted. Zero-amount writes still consume an operation.
Existing complete composite-resource authorization remains mandatory even though
the categorization writer dispatches only the selected category change.

Cooldowns use the last admitted handoff, including uncertain ones. Parent counters
span all agents in the selected space/budget; per-agent counters span every
version of that agent's delegation, policy and credentials. Replacing any of
those records cannot reset allowance. A new agent still shares the parent cap.
Lowering a limit below used allowance denies further work; no existing write is
undone. The policy editor requires the exact current version and clears its
human confirmation after a save.

## Dispatch, uncertainty and stop

An initial preflight checks limits before consuming human approvals. It reserves
nothing and cannot authorize a write. Immediately before the adapter's SDK write,
the ordinary store fence rechecks exact live authority/quorum and atomically
admits the effect under the **current dispatch-time UTC windows**. A queued
proposal cannot spend yesterday's allowance. This admission and control/stop
updates serialize through the existing workflow SQLite transaction.

A stop winning first denies admission. An admission winning first is potentially
in flight, even before the network submission becomes observable. The UI never
promises to recall that handoff. Crashes, lost acknowledgements and failed native
verification retain an uncertain admission, charged magnitude and a shared-parent
fence against new delegated categorization, including after a calendar rollover.
Changing policy, deleting workflow data or replacing an agent does not clear it.

Only the trusted native-verification path with a matching **durably stored**
success result clears the uncertainty state. Later caller arguments cannot turn
an already recorded failed/mismatched result into verification. Charged history
remains after verification. These controls do not add a retry-write or manual
quota-reset endpoint. The later rollout/recovery slice must provide its separate
current-authority read-only recovery UX; this controls slice alone does not
establish that browser acceptance or operational pilot.

## Privacy, retention and restore

The policy-management API exposes configuration and administrator attribution,
not admitted proposal identities, private budget identity or observed amounts.
It does not make a control manager a financial reader. Existing classified
Governance audit shows control updates. Source/evidence grants remain separate.

Scoped deletion discloses retained policy and dispatch accounting records and why
they remain: attribution, non-resetting shared limits and uncertain outcomes.
A consistent restore appends disabled/stopped control versions and retains the
backup's original charged/uncertain history. It never silently resumes automation.
Restored usage describes only the backup horizon; human re-enablement needs normal
fresh authority and reconciliation of the associated Actual installation.

## Verification boundary

Regression-first tests cover disabled defaults, exact version/reauthentication,
parent and agent stops, independent human quorum, final dispatch admission,
non-null matching durable verification, independent SQLite connections, UTC
boundaries, credit/debit/zero magnitude, currency refusal, cooldown, lowered and
replaced limits, uncertainty after reopen, scoped deletion and restore quarantine.
Component/route tests cover explicit guarded control saves and private management
projection. No production financial data or provider was used. These are not
completed authenticated-browser or live unattended-operation acceptance.
