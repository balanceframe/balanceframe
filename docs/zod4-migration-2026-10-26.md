# Coordinated Zod 4 migration candidate — 2026-10-26

Base: `6f008c03f69f5afdcaec797f2b26ba3bdc23db38`. This is a local candidate,
not a release. Owner approval covered upgrading the seven production Zod 3
importers; the contract test dependency follows them to Zod 4.6.6. Happy DOM
and all other package versions remain unchanged. The lockfile contains no
Zod 3 package resolution, and no first-party import uses `zod/v3`.

## Preserved boundaries

- Records use explicit string keys; recursive transactions use the existing
  generated `Transaction` interface instead of an erased schema type.
- Refined-object projections use their original field shapes. Observation
  expiry and persisted ledger-confirmation binding checks remain enforced.
- Previously optional opaque Actual rule values and CLI envelope results are
  explicitly optional. CLI's existing `hasOwn(result)` check still rejects a
  missing response result. Persisted supplemental facts retain null/missing
  behavior and their material hash binding.
- Unbounded integer fields retain the previous integer domain instead of
  acquiring implicit safe-integer bounds. Previously unbounded in-memory
  confidence/score numbers retain both infinities; finite/ranged validation
  boundaries remain finite/ranged.
- Persisted UUID references retain the original hexadecimal grammar, including
  nil and non-RFC variants. Malformed references remain rejected.
- Canonical JSON Schema, AJV configuration, Rust source and protocol fixtures
  are unchanged. Canonical fixture output hashes are pinned to the Zod 3
  parser's output, including its pre-existing metadata stripping.

## Evidence

Regression-first checks recorded the old-version collection-security failure,
the direct-upgrade unsafe-integer failure, the refined-object API failure,
the omitted-Actual-value failure, and the old production artifact's incorrect
financial Zod major. The new production guard follows the actual bulk-route
constructor binding and executes the compiled financial, canonical snapshot
and bulk approval parsers in a disposable child process. It uses allowlisted
OS environment entries, explicit disposable Actual settings and owned paths,
a Unix socket (Windows named pipe branch), a 30-second deadline and a 1 MiB
output limit. No HTTP financial write is submitted.

Latest completed checks (scenario phase is identified separately below):

| Check | Passed |
| --- | ---: |
| Full workspace build | yes |
| Root TypeScript | yes |
| Protocol | 241 |
| Workflow store | 1,018 after the stored-state correction |
| Actual adapter | 452 |
| Inference | 247 (final coverage run) |
| Application | 1,501 after the stored-state correction |
| Web | 2,365 after the stored-state correction |
| Scenario | 424 before the stored-state correction |
| CLI | 203 |
| Contract | 191 plus 8 container checks |
| Zod collection security across ten consumers | 80 |
| Full dependency security | 151 |
| Full deployment suite (including production artifact validation) | 33 (including 3 artifact checks) |

A temporary differential probe compared 212 exported protocol validators on
289 inputs built from every root canonical fixture, their immediate values,
first array elements and scalar boundaries. For baseline-success object/schema
pairs it deleted each top-level field and replaced it with null, undefined,
±2^53, 1.5, NaN, ±Infinity and the empty string. Across **68,568 comparisons**
there were **zero acceptance, parsed-output or thrown-error-type differences**;
186 fixture/schema pairs were accepted. This bounded corpus is not a proof for
all possible JavaScript objects. Invalid-input diagnostic code/path structures
differed in 19,637 comparisons.

Local evidence logs: `/tmp/zod4-build.log`, `/tmp/zod4-contract-red.log`,
`/tmp/zod4-adapter-red2.log`, `/tmp/zod4-production-red.log`,
`/tmp/zod4-production-isolated.log`, `/tmp/zod4-deployment-full.log`,
`/tmp/zod4-packages-tests.log`,
`/tmp/zod4-public-errors.log`, `/tmp/zod4-security-full.log`,
`/tmp/zod4-resolver-audit.log`, `/tmp/zod4-differential.log`,
`/tmp/zod4-coverage.log`, `/tmp/zod4-web-typecheck.log`,
`/tmp/zod4-root-lint.log`, and `/tmp/zod4-frozen.log`.
Final correction checks are retained in `/tmp/zod4-postfix-build.log`,
`/tmp/zod4-postfix-coverage.log`, `/tmp/zod4-postfix-typecheck.log`,
`/tmp/zod4-postfix-web-typecheck.log`, `/tmp/zod4-postfix-lint.log`,
`/tmp/zod4-postfix-frozen.log`, `/tmp/zod4-postfix-deployment.log`, and
`/tmp/zod4-postfix-security.log`.
The reproducible differential probe is `/tmp/zod4-differential.mjs`.

## Pending acceptance decisions and validation

Independent HTTP review reproduced corrupted server-owned merchant policy being
misclassified as caller input (409 unavailable became 400 invalid request).
The owner authorized preserving the baseline unavailable classification. The
correction uses one local decoder at all 25 persisted JSON/schema reads;
JSON syntax errors, schemas, authorization order and transaction boundaries
remain intact. Invalid stored schema values throw a withheld generic error.
Caller/access/input validation is unchanged, and application `readPolicy` was
not altered. No new error class, dependency or framework was introduced.

Regression-first evidence:
`/tmp/zod4-stored-http-red-all.log`, `/tmp/zod4-stored-unit-red-all.log`, and
`/tmp/zod4-stored-rollback-red.log`. After the correction, full merchant-store
102 tests and all three genuine HTTP regressions pass
(`/tmp/zod4-stored-unit-green.log`, `/tmp/zod4-stored-http-green.log`). They cover
eight stored-data families, policy/generation/decision rollback, no extra quota
attempt insertion, JSON syntax failures, invalid caller input, permission
denial without SDK reads, exact row restoration and successful requests.
Server, DB and fixture cleanup use nested finally blocks and fetches are bounded.

The full pre-correction scenario run completed successfully before production
source was changed: **27 files / 424 outer tests**, **1,611.28 seconds**, line
coverage **87.36% (3,092 / 3,539)**. Nested CLI selection controls intentionally
execute selected tests; their selected/skipped counts are not the outer suite
aggregate. No owned scenario manifest or live process remained. The initial
coordination-interrupted run remains incomplete (exit 130). After the correction, the full workspace build and full workflow/application/web
coverage suites pass (1,018 / 1,501 / 2,365 tests). Final root/Nuxt type checks,
root lint, frozen offline installation, deployment (33) and dependency security
(151) also pass. The 26-minute scenario run was not repeated: successful stored
JSON uses the same schemas and outputs, while the new failure path is covered
by the 102 merchant-store tests and three HTTP regressions. Existing merchant
restore/billing tests verify restore quarantine, consent reset, retained charges,
lost-billing holds, unsent cleanup and exact quota bounds.

Zod 4 changes diagnostics exposed to users. For malformed provider output,
`categoryId: 42` retains code `invalid_type` and path `categoryId`, but changes
“Expected string, received number” to “Invalid input: expected string, received
number”. `confidence: 2` retains `too_big` and its path but changes its wording.
The public inference regression verifies that output remains an error-bearing
suggestion with reason code `Error` and an empty proposed category. Other
changes include `invalid_type` to `custom` for fractional unbounded integers,
and `invalid_type` to `invalid_union` for malformed values at the explicitly
infinity-compatible number schemas. Rule lifecycle failures can expose the
new JSON-formatted `ZodError.message`. The owner approved native Zod 4 human-readable wording, without a Zod 3
formatter. Structured issue/code changes and reachable HTTP classification
changes remain pending acceptance.

Non-JSON record inputs also differ: a prototype-inherited category entry was
copied by Zod 3 and is omitted by Zod 4; a symbol-keyed record was silently
stripped by Zod 3 and is rejected with `invalid_key` by Zod 4. Empty string and
`constructor` keys and own JSON `__proto__` handling agree. No prototype or
symbol compatibility shim was introduced. Owner acceptance is pending for
these non-JSON differences.

The first complete scenario attempt was interrupted solely to coordinate the
shared heavy-test slot (exit 130). It has no aggregate pass/fail result. Its
owned Actual/web processes were terminated; the owned manifest/root/inodes
were verified before removing its temporary fixture directory. The sequential coverage run passed all pre-scenario suites, including web
(2,362). Final line coverage: protocol 96.97%, workflow 86.44%, adapter 87.63%,
inference 95.33%, contract 100%, application 89.78%, CLI 89.53%, web 85.61%.
The full scenario portion passed before the stored-state correction, as detailed above. Root/Nuxt type checks, full root
lint and frozen offline installation passed. These are scoped JavaScript
measurements, not a full workspace Rust/Actual coverage-gate pass.

Changed production-file coverage, aggregated from the scoped LCOV records and
`git diff --name-only`, is recorded in `/tmp/zod4-changed-coverage.json`:

| Changed package files | Covered / total executable lines | Coverage |
| --- | ---: | ---: |
| Protocol | 296 / 307 | 96.42% |
| Workflow | 590 / 613 | 96.25% |
| Actual adapter | 314 / 351 | 89.46% |
| Inference | 5 / 5 | 100% |
| Application | 1,952 / 2,162 | 90.29% |
| CLI | 213 / 236 | 90.25% |
| Scenario | 46 / 46 | 100% |

These meet the corresponding package thresholds. No web production file was
changed. Scenario measurement precedes the stored-state correction; workflow
measurement includes it.

The native addon was reused from the approved security worktree, with unchanged
Rust/protocol source at the base. SHA-256:
`ae79b28a0568818d95cc0c9b8fbe89e961fb26baf7295e9cb75535284906ac16`.
This is not a fresh Rust build or fresh Rust coverage measurement. The Zod 4
upstream package itself ships unused v3 compatibility files; the inspected
production trace includes only v4, and its bundled sources contain no v3
runtime. No claim is made that every byte of the upstream package is v4-only.

## Error consumer audit

Exact read-only before/after probes are retained in
`/tmp/zod4-public-diagnostics.mjs` and `/tmp/zod4-public-diagnostics.jsonl`.
Non-finite numbers and symbols are explicitly tagged so JSON serialization
does not hide their values. The probes execute the actual old/new public
Orchestrator API as well as raw schema parsing.

- Protocol and inference schemas are exported public library APIs; external
  callers can observe their raw issues. Code/path comparisons are not a claim
  that all issue metadata is stable: `received`, `type` and `exact` can disappear,
  `origin` can appear, and union failures acquire nested errors/invalid values.
- Orchestrator `errorSuggestion` exposes messages in errors, rationale and
  evidence; its payload hash includes the error message. The same synthetic
  malformed output changes hash from
  `bcc153df91c5ab473865ec8c897b32cfdd415713e699ad5b2f2098a111337f02` to
  `ffaa1897eb5972c08d9de8e3f4464cd6474eeb9e5baf70c941ad66785bca0d92`.
  A valid result retains hash
  `a103c152fe36a93b6571ca2515407648f526bd9cf7d707d5b654e3b8c6874b2d`;
  an otherwise valid result naming an unallowed category retains hash
  `55c1ace94378839ebfbfc634e79b43e06345ad6cc1f157fcf414b62bb3a5969b`.
  The wording approval does not approve the changed invalid-result hash.
  No current
  production composition caller or `saveSuggestion` invocation was found;
  the API is exported, and first-party invocations are tests. Existing saved
  records are not rewritten.
- RuleMutationService lifecycle failures are production reachable. Invalid
  persisted lifecycle preconditions produce stable `invalid_preconditions`,
  while the Zod error message enters the exported result, idempotency failure
  record and audit result. The web execution endpoint maps that stable reason
  code to HTTP 409 / `PRECONDITION_FAILED` and a generic message, masking the
  raw diagnostic in that HTTP response.
- Actual merchant normalization wraps parser failures as stable
  `invalid_source`; CLI response parsing and most HTTP boundaries publish
  generic failure envelopes instead of raw issue structures.
- Web `instanceof z.ZodError` recognizes migrated application/store errors
  which were a different major before. An independently reproduced merchant
  ASCII cursor accepted by the web's 512-character bound but rejected by native's
  256-byte bound changes HTTP 409 / `MERCHANT_OPERATION_UNAVAILABLE` to
  HTTP 400 / `INVALID_MERCHANT_REQUEST`. This is a pending contract decision,
  not an accepted diagnostic-wording change. An independent two-test probe used
  the real HTTP handler/service and SQLite membership/governance, with injected
  authentication context and SDK. Cursor lengths 257–512 reproduce that change;
  a valid 256-character ASCII cursor succeeds (200) on both, a 513-character
  cursor returns 400 on both, wrong facts remain 409, and revoked authority remains 403 with zero
  additional SDK reads. This is a focused HTTP integration probe, not a full
  browser or live Actual check. Evidence: `/tmp/zod4-decision-http.log`,
  `/tmp/zod4-http-baseline.json`, `/tmp/zod4-http-candidate.json`, and reproducible
  `/tmp/zod4-decision-http.probe.test.ts`. The probe's temporary source-tree
  file and owned fixture were removed by its reviewer. Governance/action catches also
  require reachability analysis; local web request schemas were already v4,
  and regex/name fallbacks already recognize many old errors.

No new real-browser verification has been completed: no supported browser tool
or installed browser automation package is available in this worktree. API,
component and scenario checks must not be described as browser verification.
The Windows named-pipe branch has not been exercised on Windows. No publication,
remote push, merge or live financial data access is authorized or performed.

## Remaining audit findings

One fresh read-only `pnpm audit --json` on the current lockfile reports **0
critical, 2 high, 12 moderate and 5 low** advisories (exit 1 because findings
remain), retained in `/tmp/zod4-audit.json`. The high entries are Happy DOM
(1243084, unchanged 20.11.1 in this isolated branch) and the existing node-forge
registry advisory (1240912, despite the approved existing patch). There is no
Zod advisory entry in that result. No audit fix or further package change was
performed. The separate Happy DOM 21 candidate has not been combined with this
branch here; this evidence does not establish a clean audit or combined-branch
validation.

## Handoff status

Candidate implementation and authorized preservation correction are complete,
with the validation and limits above. No commit was created and HEAD remains
at the stated base. Native diagnostic wording is approved. Structured Zod issue
changes, malformed-provider error-hash changes, the 257–512-character ASCII
caller-cursor HTTP classification, and non-JSON inherited/symbol record behavior await the
owner's explicit decision. These are acceptance blockers, not failed tests or
an authorization to add a generic Zod 3 compatibility layer.

## Owner approval and combined stack — 2026-10-26 12:00 UTC

This section supersedes the earlier handoff's pending acceptance decisions;
those earlier observations and validation phases are retained as history.
The authenticated owner explicitly approved all four disclosed compatibility
changes: native Zod 4 issue codes/structure, new hashes for malformed-provider
schema failures (valid-output hashes stay stable), HTTP 400 for caller cursors
of 257–512 ASCII characters, and own-entry/symbol-key record behavior. The
server-owned stored-data preservation correction remains required: malformed
stored merchant state returns HTTP 409 unavailable, not caller-input HTTP 400.
No Zod 3 formatter or compatibility shim is needed.

The owner also approved publication of the two new maintenance slices after
final combined validation. Publication is owned by the lead and is outside this
worker's actions. The previously denied security-only PR is not retried or
bypassed. No merge, deployment, main-branch write or live financial data access
is authorized. The security requirement remains: “Yes, I do not want to reduce
security just to appease an LLMs testing.”

Before stacking, the stash list was empty. The candidate was saved in an owned,
include-untracked stash, `c600965d87955d4dbec429bbd90079ce5bf05caf`, then only the
unpublished Zod branch was fast-forwarded from `6f008c03…` to the reviewed Happy
DOM commit `ed05d85e0e7788969c1043aa55092ddd75ecc0a1`. The exact owned stash was
applied without popping or dropping it. Both reviewed base commits are intact.
The automatic lockfile merge is clean: compared with the Happy base, it changes
only eight Zod importers/resolutions and removes the unused Zod 3 package entry;
Happy DOM remains 21.0.4. The stash remains as recovery evidence through review
and commit.

Permanent regressions now pin the approved native issue structures and error
hash, retain stable valid/non-schema-failure hashes, and check own/inherited/
symbol record behavior against canonical JSON records. The real HTTP regression
covers 256-character success, 257/384/512-character caller failures, 513-character
front-door failure without SDK reads, stale facts at 409, revoked permission at
403 without further SDK reads, and malformed stored state at 409 with repair
back to 200. These use injected authentication/SDK around real handlers,
services and SQLite governance; they are not a real-browser login test.

Initial combined checks passed: frozen offline install, 7 migration boundary
tests, 77 classifier tests, three HTTP boundary tests, and all 157 dependency
security tests. The new record test initially selected the representative
fixture's empty budget array; it now uses the existing nonempty canonical
`data-quality.json` budget. No production behavior or prior assertion was
changed for that test correction. Full combined validation follows below.

### Combined validation results on the Happy DOM base

The preceding isolated-candidate audits, pending-decision notes and validation
phases are historical. Current owner acceptance is stated in the section above;
current package versions are Happy DOM 21.0.4 and Zod 4.6.6. The combined full
workspace build, root/Nuxt type checks, root lint, frozen offline install, all
157 dependency-security tests and all 33 deployment tests pass. Deployment
checks execute the actual built financial/canonical/bulk schemas and external
API-key parser, with fixed Zod 4 bindings and no first-party v3 imports.

| Combined full package suite | Tests | Line coverage |
| --- | ---: | ---: |
| Protocol | 241 | 96.97% |
| Workflow | 1,018 | 86.44% |
| Actual adapter | 452 | 87.63% |
| Inference | 248 | 95.33% |
| Canonical contracts | 193 | 100% |
| Application | 1,501 | 89.78% |
| CLI | 203 | 89.53% |
| Web | 2,365 | 85.61% |

Combined changed-file coverage is retained in
`/tmp/zod4-combined-changed-coverage.json`: protocol 96.42%, workflow 96.25%,
adapter 89.46%, inference 100%, application 90.29%, CLI 90.25%; no web production
file changed. These meet the applicable thresholds. The unchanged scenario
source file retains 46/46 coverage from the earlier full scenario run; that
measurement is explicitly marked pre-stack, not rerun combined coverage.

Two selected disposable Actual/Nuxt integration cases also pass on the combined
artifact: `merchant-local-sparse` proves native merchant evidence and unchanged
ledger state; nonzero wallet starting equity proves independent approval and
read-only replay. Each selected command ran one case (10 and 2 other file cases
were intentionally not selected). These are selected integration checks, not a
new full scenario aggregate. The earlier 424-case scenario result remains
pre-preservation-fix/pre-stack evidence. No 26-minute repeat was needed for the
unchanged valid decode path and Happy DOM's test-environment-only upgrade.

The fresh combined read-only audit, run once, reports **0 critical, 1 high, 12
moderate and 5 low** advisories, with no Zod or Happy DOM advisory entry. The high
entry is the existing node-forge registry finding despite its approved patch.
The audit exits 1 because findings remain; no audit fix, suppression or further
package change was made. Raw result: `/tmp/zod4-combined-audit.json`.

Combined logs are `/tmp/zod4-combined-install.log`,
`/tmp/zod4-combined-http-boundaries.log`,
`/tmp/zod4-combined-contract-boundaries.log`,
`/tmp/zod4-combined-inference-boundaries.log`,
`/tmp/zod4-combined-security.log`, `/tmp/zod4-combined-build.log`,
`/tmp/zod4-combined-coverage.log`,
`/tmp/zod4-combined-scenario-merchant.log`,
`/tmp/zod4-combined-scenario-wallet.log`,
`/tmp/zod4-combined-typecheck.log`,
`/tmp/zod4-combined-web-typecheck.log`, `/tmp/zod4-combined-lint.log`,
`/tmp/zod4-combined-frozen.log`, and `/tmp/zod4-combined-deployment.log`.

The earlier native-binary identity, no-fresh-Rust-build, browser-verification and
Windows-execution limits still apply. Canonical Rust/protocol source is
unchanged. The owned stash remains retained. A local DCO-signed candidate
commit is held until independent review is terminal; the worker performs no
remote publication.

### Post-service action failure classification preservation

Independent review found a second concrete server-state classification regression
before commit. With a valid public action body and the real proposal service,
changing only a real native plan's version to `42` produced baseline HTTP 503 /
`ACTION_UNAVAILABLE` / retryable true, while the migrated error identity reached
a post-service Zod catch and returned HTTP 400 / `INVALID_BODY`. Both probes
created zero proposals and made zero financial writes. Evidence is retained in
`/tmp/zod4-action-backend-http-baseline.json`,
`/tmp/zod4-action-backend-http-candidate.json`,
`/tmp/zod4-action-backend-http.probe.test.ts`, and
`/tmp/zod4-action-backend-http.log`. This server fault was not covered by the
owner's intentional caller-cursor compatibility approval.

The authorized preservation correction removes only the redundant post-service
Zod-to-400 branch in `proposal/action.post.ts`, with a one-line explanation.
The explicit front-door body/action/decision checks remain 400; the remaining
403/409/501/503 mappings are unchanged. No new error framework, parser wrapper,
product hook or dependency was introduced.

The permanent regression reuses the existing web proposal fixture and mounts the
real H3 handler on a bounded owned loopback listener. Authentication and service
composition are injected; its service failure is the actual protocol version
schema's Zod error, not a full native-service fixture. The independent probe
above proves that actual-service reachability separately. Controls require valid
200, malformed body 400 before service use, denied selection before body/service
use, zero actual proposal records, and no execution calls or private-field leak.
It uses the existing Happy DOM environment and Node HTTP transport; no browser
sandbox setting or test deadline was relaxed.

The new regression failed meaningfully at **400 versus expected 503** before the
source correction (`/tmp/zod4-action-preservation-red.log`). Afterward all **58
proposal-action tests** pass (`/tmp/zod4-action-preservation-green.log`). A fresh
Nuxt production build has passed; full web coverage, types, lint and production
artifact/deployment checks are being completed against this final route change.
The previous eight-package combined coverage and selected Actual scenarios
remain their explicitly earlier phase; no unchanged package or 26-minute full
scenario rerun is implied.

### Final action-route verification and local handoff

This final phase explicitly supersedes the earlier combined-phase statement that
no web production file changed: `apps/web/server/api/proposal/action.post.ts`
now contains the small baseline-preserving correction described above. Earlier
eight-package counts and selected merchant results are pre-action-correction;
they are not relabeled as later runs. Only this web route's production code
changed afterward.

The first refreshed full web run passed 2,366 tests but exposed a changed-file
coverage gap: **47/59 = 79.66%**, below the unchanged 80% floor. The failure is
retained in `/tmp/zod4-action-route-coverage-before.json`. Two focused existing-
fixture controls now verify configured-budget mismatch 409 and missing-native-
binding 501, with withheld private details, no execution/reconciliation,
no new proposals and non-retryable responses. These existing correct branches
needed regression coverage; no production behavior or threshold changed for them.

Final results are green: **60 proposal-action tests**, **2,368 full web tests**,
web line coverage **85.69%**, and changed action-route coverage **51/59 = 86.44%**.
The final changed-file report `/tmp/zod4-final-changed-coverage.json` asserts all
applicable source thresholds without exclusions or lowering any floor. A fresh
Nuxt production build, root/Nuxt type checks, root lint and all **33 deployment
checks** (including the three real artifact bindings/parsers) pass on the final
route. No dependency changed after the combined frozen-install/security/audit
checks, so those results remain at the exact same lockfile.

One fresh selected nonzero-wallet-equity/proposal Actual/Nuxt case also passes
against the final built route, including its original independent-approval and
read-only-replay assertions. The other two cases in that file were intentionally
not selected; this is not a full-scenario pass claim. The previous selected
merchant case and full 424-case scenario retain their earlier phase labels.
All owned listeners and disposable fixtures were cleaned up.

Evidence: `/tmp/zod4-action-negative-controls.log`,
`/tmp/zod4-action-complete-web-coverage.log`,
`/tmp/zod4-action-final-build.log`,
`/tmp/zod4-action-complete-typecheck.log`,
`/tmp/zod4-action-complete-web-typecheck.log`,
`/tmp/zod4-action-complete-lint.log`,
`/tmp/zod4-action-complete-deployment.log`, and
`/tmp/zod4-action-complete-scenario-wallet.log`.

Independent correctness and complexity review accepted the minimal migration,
stored-data decoder, action-route correction and their focused regressions,
conditional on these now-passing checks. All four disclosed compatibility
choices have explicit owner approval. The worker may create only the reviewed
local DCO-signed commit on the unchanged Happy base. The owned recovery stash is
retained; the lead alone handles authorized publication. No push, PR creation,
merge, deployment, main write or live financial data access occurred here.
