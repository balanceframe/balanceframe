# Categorization preview SDK acceptance — 2026-10-27

The production-mode disposable acceptance is
`tests/actual-integration/14-categorization-preview.test.ts`. It uses the real
Actual SDK, the current native addon, a new canonical-fixture budget, and a real
SQLite workflow store. It requires `NODE_ENV=production` and exact loopback
fixture provenance through `BALANCEFRAME_ACTUAL_FIXTURE=1`.

The proof distinguishes application mutation forwards from normal SDK lifecycle
effects. A due schedule is configured through Actual's public `createSchedule`
API after capturing the proposal. The pending schedule metadata is uploaded by
normal synchronization and read back from a fresh cache. This is permitted
fixture activity, and demonstrates why the complete SDK lifecycle must not be
described as having zero writes. The SDK's daily schedule service already ran
during fixture setup, so this fixture does not observe its 123-minor-unit outflow
auto-posting. No internal scheduler preference or clock is reset to force it.

The acceptance assertions are:

- One independent human approval returns `approval_required`; two return
  `eligible_on_captured_inputs`. Both approvals remain active after successful
  preview. No claim, idempotency row, dispatch admission, cap-policy change, or
  non-read-admission audit change occurs during either preview. The existing
  disclosure fences append authorization read-admission audits. The proof
  accounts for those inserts in `total_changes()` and compares every protected
  row and all other audits exactly.
- The result labels its source interval `locally_observed`, `atomic: false`,
  `serverConfirmed: false`, and `maySynchronize: true`.
- The published SDK omits account type. The original financial snapshot keeps
  account coverage `partial` and its target account-type observation `unknown`.
  Category assignment uses operation-specific source sufficiency; success does
  not assert complete account metadata or liquidity readiness.
- The original transaction remains identical in a fresh SDK cache after normal
  shutdown. The pending schedule persists separately, with no transaction posted
  or account balance changed in this fixture. No proposed category is applied;
  all six explicit `ActualClient` mutation forward counters stay zero.
- An injected SDK sync failure returns a blocked result without a plan or
  protected workflow mutation. A subsequent public delegated acquisition constructs an
  existing conservative uncertain admission and write-intent hold without
  sending an SDK mutation. Preview blocks on that hold and retains every protected
  row, including after reopening SQLite.
  This fixture is not evidence of a real lost acknowledgement or dispatch.

## Recorded execution

Red: the fresh 26.10.0 server run failed its one test because
`CategorizationPreviewService` was absent. The assertion runs before the test's
own budget is created. The fixture setup budget was isolated and removed with
the owned server directory. Evidence:

- `/tmp/balanceframe-category-preview-red-production-26.10-run-20261027.log`
- `/tmp/balanceframe-category-preview-red-production-26.10-results-20261027.json`

The first implemented live run exposed an overbroad completeness
requirement: `source_incomplete` because the SDK omits account type. A diagnostic
run confirmed every other collection was complete or empty. Those failures are
retained in `/tmp/balanceframe-category-preview-{green,diagnostic,coverage}-production-26.10-*20261027.*`.
Green: Actual Server 26.10.0, SDK 26.10.0, Node 24.19.0, and Vitest 4.1.12;
one test passed in 3.109 seconds (5.86 seconds total). The successful run includes
fresh-cache public `getSchedules` readback and SQLite reopen. Evidence:

- `/tmp/balanceframe-category-preview-final-production-26.10-run-20261027.log`
- `/tmp/balanceframe-category-preview-final-production-26.10-results-20261027.json`

Green compatibility: the unchanged test passed against saved Actual Server
26.7.0 with SDK 26.10.0: 3.018 seconds (4.66 seconds total). Evidence:

- `/tmp/balanceframe-category-preview-supported-production-26.7-run-20261027.log`
- `/tmp/balanceframe-category-preview-supported-production-26.7-results-20261027.json`
- `/tmp/balanceframe-category-preview-cleanup-verification-20261027.json`

After independent review, the lead repeated production 26.10 acceptance against
the final admission and source-binding fixes: one test passed in 2.394 seconds
(4.28 seconds total). Separate evidence is retained in
`/tmp/balanceframe-category-preview-independent-production-26.10-{run-20261027.log,results-20261027.json}`;
the owned listener closed and its fixture directory was removed. Earlier worker
results were not overwritten or relabeled.

Independent review found and regression-tested three corrections: recheck read
admission after asynchronous lifecycle preparation before subsequent SDK calls;
withhold results if the server/group changes while the budget ID stays the same;
and report unknown approval requirements as unavailable rather than zero.
Independent focused core validation passed 84 tests and HTTP/UI validation passed
21. Final local application coverage passed 1,562 tests (89.93% lines), web
coverage passed 2,397 (85.83% lines), CLI coverage passed 203 (89.54% lines), and
the adapter gateway passed 139. Production build, root/Nuxt types, lint and the
isolated production SDK/SQLite bundle check pass. These gates do not replace
authenticated source-browser acceptance.

A later final 26.7 qualification exposed a fixture clock race: the action's
`now` could be sampled one millisecond before the helper sampled its
`reauthenticatedAt`. Governance correctly rejected that future authentication.
The fixture now captures reauthentication once before its control operations,
with real clocks/timers and all five-minute freshness guards unchanged. The
failing evidence remains in
`/tmp/balanceframe-category-preview-final-reviewed-production-26.7-*20261027.*`.
The corrected production test passes on both 26.7 and 26.10; evidence uses the
distinct `balanceframe-category-preview-clock-fixed-production-26.7` and
`balanceframe-category-preview-clock-fixed-production-26.10` log/result prefixes.
Independent review approved this fixture-only correction; no assertion,
production behavior, security window or timeout was changed.

No automatic retries or rate-limit changes are configured. Earlier fixture
corrections are retained in the `audited`, `realtime`, `pending`, and `fenced`
log/result families: read-admission audit accounting, daily schedule-service
behavior, the acquired final dispatch fence, and the public SDK download's group
sync ID. No scheduler internals were changed to turn those attempts green.

The current native artifact was reused, not rebuilt for this TypeScript-only
change: `crates/node-binding/balanceframe.node`, 11,601,160 bytes, SHA-256
`ae79b28a0568818d95cc0c9b8fbe89e961fb26baf7295e9cb75535284906ac16`.
No Rust source changed in this task. The SDK dependency is the repository's
existing patched `@actual-app/api@26.10.0`; no SDK/package changes were made for
this proof.

Prettier and whitespace checks pass on both owned files; ESLint passes on the test. A scoped
TypeScript check finds no error in the new test but is blocked by the existing
`tests/actual-integration/actual-client.ts:74` optional date arguments passed to
the SDK's required date signature. This check does not establish a clean typecheck
for the integration harness.

Each run uses new private `/tmp` fixture paths, restores any previous
`tests/actual-integration/.env.test`, verifies its server PID's `ACTUAL_DATA_DIR`
before stopping it, and confirms the listener closes before deleting owned data.
Both green runs have no live owned fixture process or listener and their data
directories are removed. Their exited server PIDs remain as zombie entries under
container PID 1; they hold no running server and cannot be reaped by this task.
Credentials and process environments are not printed. No real account, budget,
bank sync, or provider is used. Browser operation and OCR/device acceptance are
separate gates; this test provides neither.
