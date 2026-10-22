# E2E report validation — 2026-10-22

## Scope and provenance

The third-party `E2E-TEST-LOG.pdf` identifies BalanceFrame main
`5c845c8cd681771abb753612380814169209216f` (#37). A fresh `git fetch origin main`
returned that same revision. Changes are isolated in
`fix/e2e-report-validation-20261022`, worktree
`/workspace/balanceframe-e2e-fixes`; the original `work` checkout is preserved.
Remote branch inventory contained main and the active transaction-evidence
branch. PR38 was fetched read-only as `origin/pr38` at
`de27067e8a3dd3589a36979f06835b448aec1bb8`; its native Windows credential-store
work is excluded. Overlapping filenames were compared and the changes below
do not duplicate that feature or credential fix.

The exact source is Library item `libfile_81c5d0a97d0481918714ceb7c560cfcf`,
144,699 bytes, 11 pages. Both the first supported consumer-local materialization
and the single permitted retry failed with `library file transfer failed:
download failed`. No readable local PDF was produced. The supported Library
read did return the complete text: all 11 pages, 495 lines, `has_more=false`.
That text was read fully as untrusted evidence. Its referenced raw logs and
screenshots were not attached. No storage URL was guessed, no denial was
bypassed, and no additional transfer retry was attempted.

Only synthetic, disposable fixtures were used. Ponytail Full governed bounded
implementation and independent correctness/complexity reviews. Explicit
Sol/high worker requests were admitted; backend model identity and the running
lead's model selection were not independently attested. No difficult planning
decision required Astra or a larger architecture change.

## Claim register

Statuses apply to the fetched main revision before these local changes.
"Confirmed" does not adopt a report's suggested remedy. Intentional security
denials remain intact.

| Report claim | Status | Reproduction, disposition, and evidence |
| --- | --- | --- |
| 1. Actual 26.10 reports degraded because the default ceiling is 26.7 (rows 18/25) | confirmed | Existing live Proof 7 fails at `05-disposable-bank-sync.test.ts:638` with degraded before the fix and passes afterward against Actual server/API 26.10. Default ceiling becomes 26.10; tests still reject 26.11 and honor an explicit 26.7 limit. All 102 live tests in suites 01–09 pass, including native write/readback contracts. `/tmp/bf-health-proof7-red.log`, `/tmp/bf-health-proof7-green.log`, `/tmp/balanceframe-actual-health-evidence.md`. |
| 2. Connecting alone leaves an owner without financial access (row 41) | confirmed | Fresh production-build HTTP journey: bootstrap, Better Auth sign-in, password reauthentication, create/select space, discover/connect canonical fixture budget. Connection returns 200 and financial-grant count remains zero; financial-health, Review and Sync return 403. This is intended least-privilege enforcement. Quick Start omitted the necessary grant workflow; README now explains explicit membership/resource grants, Sync/full-read requirements and empty-queue disclosure limits. No grants or access policy changed. A more guided consent flow remains a product decision; the report's automatic owner-grant proposal was not implemented. `/tmp/balanceframe-e2e-http-evidence.json`. |
| 3. Better Auth-only readiness returns 503 (row 37) | confirmed | Regression-first auth tests expected ready but received degraded. Shared configuration predicate follows the existing Better Auth secret precedence. Production build now returns 200 with all readiness checks ok without legacy token or bypass. Migration/store failure checks remain. `/tmp/balanceframe-auth-red.log`, `/tmp/balanceframe-auth-final.log`, `/tmp/balanceframe-e2e-http-evidence.json`. |
| 4. Anonymous/invalid API credentials produce 503 and legacy configuration guidance (row 38) | confirmed | Both middleware denial paths reproduced; valid Better Auth configuration now yields existing 401 challenge/envelope. Production HTTP verifies anonymous Review and invalid Bearer Spaces requests return 401; an invalid explicit key cannot fall back to a valid session. Truly absent configuration, recorded migration failures, verified-key workflow-store failure and production bypass rejection retain 503. `/tmp/balanceframe-auth-evidence.md`, HTTP evidence above. |
| 5. Compose v2 validators reject safe explicit false bind policy (row 13) | confirmed | Installed Compose 2.40.3 omits false but retains `bind:{}`. Controlled daemon create probes show both explicit false and empty bind reject absent sources; true/short syntax accept container creation with an absent bind source. Validator accepts this equivalent normalized representation while source assertions require explicit YAML false. Negative tests reject true, removed bind block/field, and short syntax. Secret suppression and isolated renderer inputs remain. 23 deployment tests pass. Compose 2.39 and v5 were not available here. `/tmp/balanceframe-compose-evidence.md`. |
| 6. Container safety test expects obsolete prune step and is orphaned (row 14) | confirmed | Old test fails `pruneIndex >= 0`, actual -1. Runtime intentionally copies self-contained Nitro output plus native artifacts; no prune restoration is needed. Static test now checks that runtime contract, final non-root user, and all native artifact copies. Six deliberate artifact/security mutations fail. Portable safety test runs after contract tests; Linux CI runs all deployment Node tests. 147 contract + 8 static checks pass. `/tmp/balanceframe-deployment-evidence.md`. |
| 7. Unknown API path returns 200 SPA HTML (row 39) | confirmed | Live pre-fix `/api/health/report-nonexistent` returned 200 text/html. Generic API catchall now returns private JSON404 without reflecting path/query. Specific health/readiness/auth routes still win; protected paths still pass through auth. Production HTTP verifies authenticated unknown path404, public health descendant404, normal routes200, missing/invalid credentials401. `/tmp/balanceframe-e2e-unknown-before.txt`, `/tmp/balanceframe-e2e-http-evidence.json`. |
| 8a. Restricted fchown prevents installation (row 5) | not reproduced | Existing frozen lockfile installed successfully with Node24.19.0/pnpm10.24.0 and a writable pnpm store. First offline attempt lacked one cached tarball; normal frozen install completed without a version/manifest change. No filesystem privacy checks or native build validation were disabled. The report's fchown failure is an environment observation, not established product behavior here. |
| 8b. Repo does not constrain pnpm version (row 5) | not reproduced | Root `packageManager` already specifies pnpm10.24.0 and `engines.pnpm` is 10.x; Nix/Docker tooling uses pnpm10. No package upgrade, new shim or security workaround was added. |
| 9. 250,000-row adapter test exceeds 10s under unrelated shared load (rows 19/26) | not reproduced | Same full-data assertion passes isolated in 2.62s and in full adapter suites (374 tests). Existing worker serialization already avoids credential-KDF contention. No transactions, assertions, timing boundary or correctness checks were removed; timeout remains unchanged. Reproducing arbitrary external load was not treated as evidence of a product defect. `/tmp/balanceframe-misc-evidence.md`. |
| 10. CLI lacks --version (row 34) | confirmed | Executable regression returns `unknown_flags` before fix (the report imprecisely said unknown_command). Sole `--version` now prints the CLI manifest's 0.1.0 without credentials/server. Unknown commands, extra flags and help retain existing behavior. 179 CLI tests pass; spawned executable V8 coverage100%. `/tmp/balanceframe-misc-evidence.md`. |
| 11. Chromium prerequisite undocumented (row 29) | not reproduced | Main README already says "installed Chromium/Chrome" and supplies `--chromium-path` for the real Review benchmark. Browser runner validates absolute executable path, file type and execute access. No browser download/package or weaker sandbox was added. Interactive verification here is separately environment-limited as recorded below. |
| 12. groupId fails where public budget file ID succeeds (row 40) | not reproduced | The exact reported live groupId retry was not independently executed. Source/contract trace confirms public budget `id` selects and binds the budget; adapter uses `groupId` specifically for SDK downloads. These identifiers are intentionally distinct. The production HTTP test successfully connects by public ID. README now distinguishes IDs for selection/grants; API contract and scope/binding checks remain unchanged. Accepting arbitrary sync-group IDs would change that contract and was not implemented. `/tmp/balanceframe-misc-evidence.md`. |
| 13. Recursive pnpm stops at the first failing package (row 15) | confirmed | Intentional runner behavior, not a product defect. The initial native smoke failure also stopped its enclosing pnpm invocation as designed. Independent package checks and existing CI coverage orchestration retain their own results. No success masking or dependency validation changes were made. |

No claim was found already fixed by a newer main revision: fetched main equals
the report's tested revision. Some claims overlook documentation/constraints
already present there; those are recorded as not reproduced instead.

## Validation

Regression tests preceded implementation. Independent correctness and
complexity workers reviewed connected code and active-branch overlap; the
complexity review caught a draft documentation error about Sync requiring
full-read, which was corrected before finalization.

Completed checks:

- Actual adapter: 374 tests; line coverage87.36%, connector85.13%; changed
  ceiling line executed. Lint and adapter typecheck pass.
- Live Actual26.10: 102 tests across all nine suites. The first 01–08 run
  passed101; suite09 passed after building existing inference/native outputs.
  Assertions were unchanged to resolve those setup prerequisites.
- Web: full suite116 files/2023 tests. Focused changed auth/catchall coverage:
  statements92.63%, branches88.2%, functions100%, lines94.11%.
- CLI: 179 tests; package statements88.33%, branches81.98%, lines89.24%.
  Separate subprocess V8 collection covers executable entrypoint100%.
- Contract: 147 tests plus eight static container safety checks. All23
  deployment tests and offline Compose validator pass; no skipped tests.
- Fresh native release build and complete native smoke pass. The saved
  environment's cached native binary lacked an export; it was replaced only
  in this worktree by rebuilding the unchanged Rust sources.
- Fresh Nuxt production build, root lint, root typecheck, coverage-tool tests,
  shell syntax and `git diff --check` pass.
- Production HTTP journey uses real Better Auth sessions, no legacy token,
  development bypass disabled, isolated auth/workflow/connection paths and
  the canonical disposable Actual fixture. Eighteen observed requests verify
  readiness/authentication/status precedence and unchanged financial denial.

Independent review evidence: `/tmp/balanceframe-correctness-review.md`; worker
implementation notes are named in the register. Detailed temporary evidence is
local to this execution environment; it is not the report author's missing logs.

## Remaining limits and cleanup

- **Local PDF bytes:** materialization failed twice as described above;
  complete supported Library text was available. No approval denial was
  reported, and no readable local PDF is claimed.
- **Interactive browser:** Chromium aborted before opening a page because its
  SUID sandbox helper is not correctly configured. The exact failure is in
  `/tmp/balanceframe-e2e-browser.log`. No `--no-sandbox`, permission changes,
  security bypass, or alternate security configuration was used. HTTP and
  component checks are not end-to-end browser sign-off.
- **Coverage/environment scope:** full workspace aggregate coverage, Nix,
  production Docker image execution, native Windows, live merchant providers,
  and additional Compose versions were not verified. No financial core code
  changed. No claim of release readiness follows these local checks.
- Actual server PID2319 and `/tmp/bf-health-actual26.10` ownership was explicitly
  handed from the fixture worker to the lead before cleanup. Web processes
  were identified from their owned launch/session and exact command. An initial
  `/proc/9911/cwd` ownership probe was denied with PermissionError13; command
  identity verification provided a permitted alternative and shutdown succeeded.
  Final identity-verified shutdown stopped Actual PID2319 and production web
  PID20273; loopback ports3032/5026 are closed. Generated connection/auth/fixture
  credentials are excluded from the branch.
- Compose probe containers, scratch image and networks were removed. The
  separate daemon may retain directories under its uniquely owned
  `/tmp/balanceframe-bind-probe-2_n1ou9o/{true,short}/missing.json`; its filesystem
  is not the client filesystem. Existence is unverified and no privileged
  helper/cleanup deployment was used. Recovered event evidence is
  `/tmp/balanceframe-compose-daemon-events.json`.

No packages were added/upgraded, grants broadened, access changed, branches
merged, or release/deployment performed. Initial local results were reported
before publication. The user subsequently approved pushing this fix branch and
opening draft [PR39](https://github.com/balanceframe/balanceframe/pull/39).

## Publication CI follow-up

The approved initial publication head was
`ea04abad53a495514e4168ca2007ed7422ac3bd7`. Its first CI run39762739322
passed macOS ARM64. Linux passed Nix validation, build, typecheck, lint and
dependency-security checks, then failed two unsafe Compose policy controls
using Compose5.3.1. The safe baseline passed, but explicit-true and short-syntax
controls returned validator0. The log did not retain the unsafe rendered JSON;
the exact serializer cause is unverified.

The bounded fix retains those controls and adds a separate private
`config --no-interpolate --no-normalize --format json` model. It requires an
explicit false on the exact read-only research bind and a complete raw volume
set containing only that bind and the canonical data volume. Existing normalized
checks still validate actual resolved source paths and the full deployment.
Deterministic tests reproduce lost normalized policy evidence and reject true,
short syntax, an unrelated false decoy, missing raw policy evidence, and long-
or short-syntax mounts whose interpolated targets collide with the safe target.
Independent review reproduced the collision before the complete-set check and
confirmed rejection afterward.
Local Compose2.40.3 passes all30 deployment tests; actual Compose5.3.1 rerun is
required. No parser/package installation or security assertion removal.

Windows also exposed CRLF sensitivity in the new static artifact test. A
canonical-source fixture executes the actual test under LF and CRLF, and
requires rejection of each of three missing native artifacts under both.
Before the fix,3/8 regression cases failed; normalizing CRLF at the Dockerfile
read makes all eight pass without changing exact artifact comparisons. The
contract invocation now passes155 Vitest cases plus eight static checks.

Two earlier Windows failures in that run report cache-path traversal for normal
server URL keys in adapter/application tests. They originate in main's
POSIX-only containment comparison and are already fixed in active PR38's
platform-aware direct-child guard. PR38 also splits the portable test step so
an earlier failure cannot be hidden by the last command succeeding. Neither
fix is duplicated here. Windows verification requires inspecting raw suite
results even if the inherited multi-command step later reports success.

Read-only comparison refreshed PR38 to
`3334f6fbef707b9d45d9cb563c2e207e8fd6b87a`. Four shared filenames have distinct
hunks; the initial report patch passed an isolated temporary-index apply-check
against that revision. Combined Windows validation depends on integrating and
retesting the separate PR38 fixes when authorized. No integration, merge, tag,
release, deployment or access change is part of this draft PR.

Follow-up local evidence: `/tmp/balanceframe-compose-ci-evidence.md`,
`/tmp/balanceframe-container-ci-evidence.md`; first-run CI logs are
`/tmp/balanceframe-ci-linux-ea04aba.log` and
`/tmp/balanceframe-ci-windows-ea04aba.log`.
