# Categorization simulation: blocked source boundary and decisions

Status: **blocked before application/API/CLI/UI implementation**. Neither option
below is implemented or approved by this packet. No simulation report or financial
write was created. The existing shared store preflight is a partial prerequisite;
it is not a completed current-source simulation or rollout acceptance.

Investigation baseline: `c9c6069bbf99a4245cff852b91f5cdef3df8a336`, branch
`feat/delegation-categorization-simulation-20261027`, 2026-10-27. The original
store changes were handed off by the lead; this investigation preserves their
source and dated test evidence. Subsequent local integration is recorded below.
The intended capability remains the independently approved categorization path
described in [the accepted controls](delegated-categorization.md) and
[ADR 0007](adr/0007-delegated-operational-limits-proposal.md).

## Why source acquisition is blocked

The requested simulation must not dispatch a financial write, including during
source acquisition and cleanup. The current observer rejects adapter mutation
methods and uses its own temporary cache. Those protections remain necessary,
but they do not establish a read-only lifecycle inside the installed SDK.

The installed, patched `@actual-app/api` is version `26.10.0`. Its
`dist/index.js` SHA-256 is
`1191509c5c629d99bdf6d4d96637c66abb3fe6e11da2428b4cec30d154ea58c7`.
These are source inspection findings, not an observed remote mutation:

| Boundary             | Exact call chain in this checkout                                                                                                                                                                                                                                                                |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Observer composition | `packages/application/src/connection-manager.ts:463` creates `ActualConnector` with `mode: 'observe'`; its default cache is `mkdtempSync` in `packages/actual-adapter/src/connector.ts:615`.                                                                                                     |
| Initial selection    | `ConnectionManager.restoreConfiguredBudget` calls `connector.selectBudget`; `connector.ts:2306` calls `client.shutdown()`, then reinitializes and calls `client.downloadBudget(info.groupId, ...)`.                                                                                              |
| Observer refresh     | `connector.ts:698` avoids the explicit `client.sync()` branch and calls `client.downloadBudget(groupId, ...)` instead.                                                                                                                                                                           |
| SDK download         | `dist/index.js:131133` dispatches `api/download-budget`. That handler at `112633` uses `load-budget` plus `sync-budget` for an existing local budget. A fresh download goes through `downloadBudget$1` at `121633`, then `loadBudget$1` and `syncBudget`.                                        |
| SDK loading          | `_loadBudget` at `121821` runs `updateVersion`, can replay pending messages, and later runs `createAllBudgets`. Its non-test path at `121893` calls `possiblyUpload` (`61939`), which can start `upload()`. A fresh owned cache does not prove that loading generates no syncable local changes. |
| SDK synchronization  | `syncBudget` at `121661` calls `initialFullSync` at `62569`, which calls `fullSync`. `_fullSync` at `62641` reads `getMessagesSince(since)`, encodes those local messages, and posts them to `/sync`. The operation can upload as well as receive.                                               |
| SDK cleanup          | Exported `shutdown` at `131465` calls `internal.send('sync')` before `internal.send('close-budget')`. `createDefaultActualClient` at `connector.ts:529` forwards shutdown unchanged.                                                                                                             |
| Manager cleanup      | `withConnection(..., { dispose: true })` reaches connector disconnect and SDK shutdown. A lifecycle ownership change or error cleanup can also disconnect. Omitting immediate disposal is not proof of safe eventual cleanup.                                                                    |

The observer tests in `packages/actual-adapter/test/gateway.test.ts` prove that
the adapter chooses `downloadBudget` and rejects explicit mutation methods.
Their injected SDK mocks do not prove that real SDK download/shutdown cannot
upload. They are useful tests of their stated adapter seam; they must not be
weakened or presented as end-to-end no-write evidence.

Reproduce the source inspection without starting Actual or using credentials:

```bash
node -p "require('fs').realpathSync('packages/actual-adapter/node_modules/@actual-app/api')"
node -p "require('./packages/actual-adapter/node_modules/@actual-app/api/package.json').version"
sdk_file="$(realpath packages/actual-adapter/node_modules/@actual-app/api)/dist/index.js"
sha256sum "$sdk_file"
rg -n 'async function shutdown|async function downloadBudget|async function _loadBudget|async function initialFullSync|async function _fullSync' "$sdk_file"
sed -n '112633,112678p' "$sdk_file"
sed -n '121633,121670p' "$sdk_file"
sed -n '121821,121900p' "$sdk_file"
sed -n '62641,62660p' "$sdk_file"
sed -n '131465,131477p' "$sdk_file"
```

Line numbers describe this exact patched artifact. If its hash changes, locate
and inspect the functions again rather than assuming the evidence still holds.
No package, SDK internals, synchronization mode, lifecycle assertion, filesystem
permission, or security policy was changed to obtain these findings.

## Existing callers share the inherited boundary

This is inherited behavior, not a source path introduced by the store preview
patch. Existing Purchase Check calls `apps/web/server/api/purchase/evaluate.get.ts`
→ `liquidityRoute` in `apps/web/server/utils/liquidity-service.ts` →
`createDefaultConnectionManager` → `LiquidityService.capture` in
`packages/application/src/liquidity-service.ts:338` → `withConnection` with its
default synchronization enabled. Existing data-quality and other analysis routes
also compose the default observer manager.

Therefore those evaluations use an upload-capable SDK lifecycle too. This does
not prove that an evaluation changed a financial value. It does prevent claiming
that the complete real-SDK lifecycle has been verified to produce zero financial
writes. A new explanation operation reusing Purchase Check can be read-only in
its application/provider operation while inheriting this unresolved source
lifecycle. Keep those claims separate until the adapter boundary is resolved.

## Source options requiring a decision

| Option                            | Smallest useful scope                                                                                                                                                                                 | Semantics and remaining work                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A: existing read capture          | Server-only simulation over an explicitly provided existing capture, with normal current human full-envelope read admission. It performs no new ledger connection, refresh, SDK load, or SDK cleanup. | Label the capture historical or stale. Do not publish `would_execute`, current-source validity, or a current dispatch prediction. Bind the immutable report privately to capture, proposal and current authorization; recheck current authorization after computation. This changes the original requested current-source semantics and needs approval before implementation. It does not solve acquisition safety for the producer of that capture. |
| B: verified read-only acquisition | A supported source acquisition and disposal contract that cannot upload local financial changes, followed by the ordinary native plan/precondition checks.                                            | Requires an adapter architecture/SDK decision and regression evidence across download, load, refresh, failure, ownership changes and cleanup. Do not infer safety from `mode: 'observe'`, a fresh cache, no explicit `sync()` call, or one fixture with no observed changes. Do not implement a private SDK-message workaround under the simulation task.                                                                                            |

Neither option changes ordinary Execute, human quorum, durable caps, uncertainty
fences, or the prohibition on using a simulation result as authority. The
application route, CLI command, UI and report storage are intentionally absent
until the selected semantics can be implemented completely.

## Human/agent privacy decision, independent of source option

The current proposal read boundary deliberately uses `!agentPrincipal` for
private full-envelope disclosure in `packages/workflow-store/src/store.ts:5874`.
Execution capability does not grant that read. Preserve this boundary and deny
an agent before ledger I/O. A caller may never nominate a different agent or
human for the preview.

| Choice                                      | Benefit                                                                                                                                                                                               | Oracle and trust implications                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Retain human-only preview                   | Reuses current independent full-envelope read authority and actual authenticated human identity.                                                                                                      | Smallest authorized scope. Clearly label it a current-human or historical-human simulation, according to source option. It cannot prove that any agent may dispatch under its delegation, shared caps, cooldown, stop or credentials.                                                                                                                                                                                                                               |
| Separately approved coarse agent simulation | A server-owned operation could check the actual bound agent's current execution scope and, where necessary, independent human quorum, without returning raw facts, amounts, hashes or usage counters. | Even a coarse allow/deny result can reveal proposal existence, category/amount eligibility, cap exhaustion, stop state or other principals' shared activity through repeated probes. It needs explicit admission/disclosure rules, bounded probes and an audit contract; current execution authority is not itself permission to disclose these facts. Human preflight must never be reported as an impersonated agent result. This alternative is not implemented. |

Actual bound-agent execution through the existing independently approved path
remains a separate pilot. A simulation does not issue credentials, grants,
approvals, claims, reservations, execution admissions or authority.

## Preserved evidence and limits

The lead's shared `previewCategorizationExecution` patch reuses acquisition
preflight and returns before claims, approval consumption and dispatch. It checks
actual credential binding, current human quorum and delegated controls; private
`contextHash` binds that context. Its internal `would_execute` result describes
store preflight only and must not be exposed as completed source simulation.

The retained failing-first run is
`/tmp/balanceframe-delegation-simulation-store-red-20261027.log`; its name filter
selected three preview tests, so the runner's 117 filtered tests were not a full
suite acceptance run. The subsequent full file run in
`/tmp/balanceframe-delegation-simulation-store-full-20261027.log` passed all
120 tests with no skipped tests. Store build evidence is in
`/tmp/balanceframe-delegation-simulation-store-build-20261027.log`.
These are existing lead-produced logs, not fresh source-lifecycle verification.

No live user data, provider, Actual fixture process, browser retry, financial
dispatch, report persistence, application integration, or new package was used
for this investigation. Browser acceptance remains blocked by the separately
recorded host sandbox failure. This packet is a decision handoff,
not completed current-source simulation. Publishing a partial draft for source
review does not accept either source architecture or agent disclosure alternative.


## Reviewed partial prerequisite

The store-only preflight is committed as
`5be78d39be62a5772ab615c379cec3853ffe3d5a`. Independent review found that a
pending-quorum preview initially reused proposal-phase scope. A failing-first
regression now requires execute-phase scope even while human approval is pending;
agent execution retains its existing exact-human-quorum denial. SQLite
`total_changes()` assertions verify successful and denied previews make no
logical workflow-state changes. No API publishes the private context hash.

A non-rewriting signed merge (`b45a60501f1a654d4f2bbbe3f7f039dad69162d1`)
incorporates reviewed controls/security head
`1d8dcea22d1fb01c282d91f33cc963d77dbf19b0`. On that combined approved graph,
full store coverage passes **1,068/1,068** tests, including 122 governance tests,
with 86.68% lines and 83.81% statements. Package build, root types and lint pass.
The historical pre-correction red/green and 1,059-test pre-merge evidence remain
separate; no source integration, provider or production rollout is inferred.
The earlier existing native artifact was reused from unchanged Rust source;
these checks are not a new Rust/native coverage gate.
