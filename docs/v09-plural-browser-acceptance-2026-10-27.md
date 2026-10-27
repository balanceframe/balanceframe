# v0.9 slice 1: plural recovery browser handoff

**Blocked: no browser acceptance passed in this investigation.** The installed
Chromium aborts before opening a page with its normal sandbox. This is a
reviewable acceptance handoff, not a release sign-off or a new runtime harness.

Inspected source: main `6fe0c2d4075d841bdc45d9d12ecda2e7a24df265`.
Date: 2026-10-27. The [beta UI audit](beta-ui-audit-2026-10-23.md) and
[implementation status](roadmap/post-mvp/11-5-implementation-status.md) remain
historical evidence; their aggregate test totals were not rerun here. The
focused SDK evidence added in this slice is recorded separately below.

## Evidence already available

| Evidence | What it establishes | What it does not establish |
| --- | --- | --- |
| Beta audit, 2026-10-23 | Browser receipt preview, evidence resolution, wallet preview, session creation and completion-proposal readiness | Plural execution, lost acknowledgement, source restart or recovery |
| `packages/scenario-kit/test/acceptance/evidence-receipts.test.ts`, `evidence-plural-allocation` | Genuine Better Auth, disposable Actual, three distinct actors, two independent reviewers each saving their own matrix, native split readback, replay and denial checks | Browser operation, lost acknowledgement or process restart |
| Main baseline `tests/actual-integration/12-evidence-matrix-governance.test.ts` | Governed SDK amendments; second acknowledgement lost after persistence; expired read-only proof; exact native readback. The implementation status records passing server 26.7.0 and 26.10.0 runs | Browser operation or durable store/web restart; the baseline used one approver |
| `packages/scenario-kit/test/fault/evidence-fault-contract.test.ts`, plural lost-ack case | SQLite close/reopen after expiry; readback mismatch holds; corrected readback verifies with exactly two writes | Actual transport, Better Auth/browser or two-reviewer quorum; this fixture uses one approver and synthetic connector writes |
| Main #48: `packages/application/test/liquidity-service.test.ts`, invalid source-facts cases | Lost-ack completion stays held for invalid parent/child errors and missing/false split-parent markers, including flat rows and tombstone shadowing; corrected source recovers without another add | Browser execution or a plural-amendment fault run; these are session-completion regressions |

Do not repeat the beta audit's passed read journeys to claim closure of these
remaining mutation/recovery gaps. API/component tests support the decision but
cannot supply the missing browser evidence.

## Focused durable SDK evidence added in this slice

The existing test 12 now requires two distinct independent approvers through
ordinary governance/store handlers, rejects execution with only one approval,
and loses the second SDK acknowledgement after the two Actual amendments.
It closes/reopens the same SQLite workflow file and rebuilds all three
application services with the original encryption key and connection managers.
It compares the entire durable proposal and both approval records, the original
payload/hash/preconditions, then reconciles read-only before and after expiry.
A repeated reconciliation retains exact parent/child data, IDs, count and cash;
the SDK update counter stays exactly two. No Execute call follows uncertainty.

Fresh isolated fixtures passed **one test each, no skips**, against running
`@actual-app/sync-server` **26.7.0** and **26.10.0**, checked through `/info` and
`ACTUAL_EXPECTED_SERVER_VERSION`. The quorum red control restored the baseline
one-approver policies and failed `expected 1 to be 2` before any amendment; the
final policies require two. Local sanitized receipts:

- Red control: `/tmp/balanceframe-plural-reopen-20261027-fljo8t9g/`.
- Passing profiles: `/tmp/balanceframe-plural-reopen-20261027-yu5pwzge/`, each
  profile's `test.log`, `server-info.json`, and `cleanup.json`.

Fixture-owned process groups stopped, ports closed, private data/client roots
and generated `.env.test` files were removed. A first cleanup port probe raced
kernel listener teardown; a subsequent check confirmed connection refused and
is recorded in the red control's cleanup receipt. No foreign process was stopped.

Offline frozen installation with installed pnpm 10.24.0, prerequisite
adapter/store/inference/application builds, root TypeScript, focused zero-warning
ESLint and `git diff --check` passed. The existing unchanged-source native addon
SHA-256 is `ae79b28a0568818d95cc0c9b8fbe89e961fb26baf7295e9cb75535284906ac16`;
this is not a fresh Rust build or a complete workspace coverage run.
Focused strict typing of test 12 remains blocked solely by the unchanged
`tests/actual-integration/actual-client.ts:74` optional-date mismatch
(`string | undefined` passed to `string`), also recorded by the earlier parity
work. Root TypeScript does not include this integration-test entrypoint.

This is **SDK/application/SQLite evidence** with synthetic human-session auth
contexts. It does not claim genuine Better Auth or source-browser/process
restart, malformed-marker plural SDK recovery, provider acceptance or release
readiness. The browser checklist below remains open. The existing authenticated
scenario separately supplies two-reviewer private matrix review evidence.

To repeat only this focused test, provision a fresh owned fixture using the
[version-profile instructions](../tests/actual-integration/README.md), then run
from the repository root (use the other exact version for its separate fixture):

```bash
BALANCEFRAME_ACTUAL_FIXTURE=1 ACTUAL_EXPECTED_SERVER_VERSION=26.7.0 \
  pnpm --filter @balanceframe/actual-integration exec vitest run \
  12-evidence-matrix-governance.test.ts --maxWorkers 1
```

## Exact host failure

One attempt ran as `uid=1000(agent)` using Chromium
`154.0.8037.57 built on Debian GNU/Linux 13 (trixie)`:

```text
/usr/bin/chromium --headless --disable-gpu --no-first-run \
  --no-default-browser-check \
  --user-data-dir=/tmp/balanceframe-browser-preflight-20261027-dphokh8q/profile \
  --dump-dom about:blank
exit: SIGABRT (-6); stdout: empty
FATAL:sandbox/linux/suid/client/setuid_sandbox_host.cc:172
The SUID sandbox helper binary was found, but is not configured correctly.
Rather than run without sandboxing I'm aborting now.
```

`stat` reports `/usr/lib/chromium/chrome-sandbox` owned by `nobody:nogroup`,
mode `4755`. Stderr also reports `chrome_crashpad_handler: --database is required`
and an unsuccessful `mkdir`. The complete local diagnostic is
`/tmp/balanceframe-browser-preflight-20261027-dphokh8q/result.json`; that temporary
path is not a durable published attachment. The fatal excerpt above is retained
here. No page, network assertion, screenshot or application result exists.
No sandbox fallback, permission change, namespace workaround or retry was used.
No Actual/web fixture was started for the browser attempt. The separate SDK
checks below subsequently used fresh disposable Actual fixtures.

## Resume on a host with an ordinary working browser sandbox

Use a clean checkout of the exact reviewed head, the existing installed
dependencies/native addon and Actual server. Follow [AGENTS.md](../AGENTS.md)
and the [existing walkthrough](../README.md#transaction-evidence-walkthroughs-v090).
Record source HEAD, native-addon hash, running Actual `/info` version and browser
version. First prove `about:blank` opens with the normal sandbox as a non-root
user. Do not use the existing Review benchmark as a replacement for this journey;
its browser helper adds `--no-sandbox` when run as root.

The existing runnable starting point, after the normal source build, is:

```bash
pnpm demo --scenario evidence-plural-allocation
```

Open the printed loopback demo URL, then **Open active scenario** to
`/review#transaction-evidence`. This supervisor creates its own disposable
Actual budget, real Better Auth personas and separate auth/workflow/connection
files. Both authentication bypass variables are false. It selects the seeded
budget explicitly. Record the generated budget/group, space, document, receipt,
parent transaction, category and actor/membership IDs privately; verify they are
from this invocation. Never substitute personal budget/configuration paths.
Generated credentials, cookies and process environments stay out of logs.

Use the existing exact grants from ordinary setup. Owner, `coapprover` and
`approver` must be distinct real sessions; each reviewer needs its own authorized
source and evidence views and must save its own matrix. Do not copy private
review rows, approve through SQLite, infer authority from a persona role or grant
reviewers budget-wide access/execution to make the flow work. Demo guarded
confirmation uses `CONFIRM` through its normal Better Auth proof path.

### Controls still needed before the fault journey can run

The current demo has no lost-ack or malformed-SDK-readback control and no
supported restart that preserves an initialized workspace. **Reset shared demo**,
switching scenarios and `loadScenario` create replacement state; none proves
restart persistence. `stopScenarioProcesses({ retainRoot: true })` can retain
files, but `startScenarioShell` requires an empty directory, so those calls do
not form a restart recipe.

A permitted-host controller must therefore first demonstrate these test-only
capabilities against its owned fixture, without changing production safeguards:

1. Lose the adapter acknowledgement only after Actual commits the second exact
   amendment, and count the two SDK writes independently. Dropping only the
   browser HTTP response tests client uncertainty; it does not necessarily put
   the server proposal into `review_required`.
2. Stop and restart only its source web process with the same isolated auth,
   workflow, connection, credentials, evidence key, budget and origin. Keep the
   owned Actual server/data. Preserve SQLite/WAL integrity and prove process exit.
3. Supply malformed split-parent readback from a reversible test-only SDK seam,
   then restore the original source view. Do not corrupt a real budget, accept
   malformed facts as complete, or change the host clock/authentication expiry.

No such controller was implemented or exercised here. Without it, record the
happy-path browser result separately and leave fault/restart acceptance blocked.

## Remaining acceptance checklist

All rows below are **open**. Capture observable UI state after each navigation,
relevant request/response, page/console errors and an independent Actual SDK
snapshot. Use state waits; a successful endpoint alone is insufficient.

| Step | Action and exact acceptance invariant |
| --- | --- |
| Baseline | Read both existing imported settlements and immutable metadata. Their debits are USD 700 and 500 minor units; receipt lines total 600 each. Capture account cash and every parent/child ID. |
| Review | Enter four positive allocation cells: line 1 → payments 1/2 = 400/200; line 2 → payments 1/2 = 300/300. Category totals are 600/600 and payment totals 700/500. Preview and save change evidence only. |
| Quorum | Prepare the ordinary composite proposal. Record payload/allocation hashes. Requester cannot approve. Each independent reviewer previews/saves the same matrix in their own session, sees that same payload, and approves. Quorum progresses 0 → 1 → 2. At 0/1 approval, execution is refused and native data stays unchanged. Reviewers cannot execute. |
| Lost ack | Owner executes once. With the controller above, Actual receives exactly two amendments and the second acknowledgement is lost. Capture the resulting uncertain/held UI and durable proposal; do not click Execute again. |
| Restart | Restart only the owned source web process. The same actor, selected budget, proposal/payload, reviews and uncertainty survive. Reopen the proposal; use **Check prior execution**, the read-only reconciliation action. No new proposal, approval, amendment or transaction may be created. |
| Malformed marker | While the controller supplies a false/missing parent marker with otherwise matching children, require the hold to remain and recovery proof to remain absent. Preserve partial source coverage and the visible diagnostic; no retry-write, inferred parent marker or released hold is acceptable. Include the flat-row/tombstone variant only if the controller can supply it faithfully. |
| Corrected source | Restore the original valid source view, then check prior execution again. Require exact read-only proof and verified state only when the service's normal timing/recovery conditions permit it. Do not bypass an active attempt lease; an early continued hold can be correct. |
| Native invariant | Parent IDs, imported IDs/payees, dates, notes, cleared/reconciled state and cash are unchanged. Parent amounts remain −700/−500; exact split amounts are [−400, −300] and [−200, −300], parent category null, `is_parent: true`, valid child-parent identities and no SDK errors. Capture child IDs and require them unchanged after further read-only checks. Total economic amount is −1200, not parent-plus-child double counting. |

Record separately whether recovery was after real expiry or within an active
lease; the existing SDK test's synthetic clock advance is not a browser expiry
observation. Do not invoke Execute again to prove idempotency in this journey.

## Receipt and cleanup

For each open row retain its status (`passed`, `failed`, `blocked`), exact source
head, fixture IDs, actor mode, observed UI text/control state, sanitized network
outcome, before/after SDK digest, amendment count and evidence file location.
Keep missing observations explicit. Do not mark the implementation-status gate
complete from this document.

Close owned tabs and stop the supervisor with Ctrl-C. For the additional restart
controller, stop only its recorded web/Actual process handles/groups, prove exit
and closed owned ports, then remove only its owned temporary root. Never reset
before collecting durable recovery evidence. Confirm no credentials, fixture
state, generated source changes or unrelated processes remain.

This slice changes the integration test and this handoff. Production code,
dependencies, security assertions and deployment are unchanged. Its financial
writes occurred only in its fresh disposable Actual fixtures.
