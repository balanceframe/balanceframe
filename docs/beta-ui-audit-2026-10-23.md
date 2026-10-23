# BalanceFrame beta audit — 2026-10-23

Baseline: main / v0.9.0-beta.1 `ee2a558641bef2dc2fba5539771b4e1425faef9a`.
Worktree: `balanceframe-audit`, branch `fix/beta-ui-audit`. Original checkout preserved.

## Issue inventory (initial findings shared before implementation)

| ID | Finding | Evidence | Status |
|---|---|---|---|
| BF-1 | Space discovery failure is silently discarded, leaving missing picker and circular recovery guidance | LAN dashboard/Spaces + default layout source | Fixed shell recovery; operational storage root cause unknown |
| BF-2 | Review shows empty queue despite load failure | LAN /review + review.vue | Fixed; error/empty regression coverage; deployed failure not reproduced locally |
| BF-3 | Five evidence scenarios launch nonexistent /evidence | Catalog + page route inventory | Fixed; final browser opens expanded Review evidence panel |
| BF-4 | Cash Flow initial insufficient-data branch hides Project control | LAN /cash-flow + real AnalysisPage branch | Fixed; browser generated three exact monthly rows |
| BF-5 | Reports first-use empty state hides Generate and saved-view controls | reports.vue + real AnalysisPage branch | Fixed; browser generated first report |
| BF-6 | Analysis pages discard retryability and omit retry handlers | AnalysisPage contract + eight callers | Fixed; regression tests cover retry metadata and parameter recovery |

LAN observation is read-only. Missing space blocks financial paths; no conclusion about live data or storage root cause. Health is liveness, not UI acceptance. Existing evidence-retention warning remains diagnostic, not a proven code bug.

## Route checklist

| Route | Status |
|---|---|
| `/calendar` | Browser: insufficient history empty state in evidence fixture |
| `/cash-flow` | Final browser: initial Project visible; three zero-flow months preserve 150.00 USD; invalid zero months disables Project |
| `/connection` | Attempted; browser control became unavailable before final rendered state |
| `/data-quality` | LAN blocked by missing space; isolated browser table rendered |
| `/demo` | Browser: 45 cards, persona and scenario switch; BF-3 failed entry reproduced |
| `/forecast-accuracy` | Browser: calibration table populated |
| `/health` | Browser: qualified health score and freshness warnings |
| `/income` | Browser: income/reliability tables populated |
| `/` | Browser: evidence blockers and deep links; BF-7 bare null days found |
| `/invite` | Not browser verified; source and automated scenarios only |
| `/liquidity/settings` | Browser: complete policy/preferences forms; guarded save disabled without confirmation |
| `/liquidity` | Browser: exact account/category backing and settings link |
| `/login` | Not browser verified; source and automated scenarios only |
| `/notifications` | Browser: Forbidden for evidence scenario persona; access limitation |
| `/obligations` | Browser: insufficient data in evidence fixture |
| `/proposals/[id]` | Not browser verified; source and automated scenarios only |
| `/purchase-check` | Browser: fictional evaluation returns explicit coverage/horizon blockers |
| `/reports` | Final browser: empty history exposes report controls; generated spending report. Saved view persistence unverified |
| `/review` | Browser: empty queue valid; synthetic receipt image, evidence resolution and wallet claims preview; final entry/expected demo-denial message verified; failure recovery covered by component tests |
| `/rules` | Browser: empty rules and merchant policy/research defaults loaded; no external dispatch |
| `/scenarios` | Browser: invalid comparison produces validation message; inputs remain editable |
| `/setup` | Not browser verified; source and automated scenarios only |
| `/spaces` | Browser: selected space, membership/grant/policy forms render; no writes |
| `/spend-sessions/[id]/completions/[proposalId]` | Browser: scoped exact debit and approval readiness render; no execution |
| `/spend-sessions/[id]` | Browser: exact cart totals, claims, completion proposal created in disposable data |
| `/spend-sessions/new` | Browser: created and evaluated synthetic one-item session |
| `/targets` | Browser: baseline blank values/NaN% reproduced (BF-9); final browser: populated exact amount/status cells, no NaN; no sinking funds fixture |
| `/transfer/[id]` | Not browser verified; source and automated scenarios only |
| `/trends` | Browser: tables render canonical history |

45 scenario families mapped by independent source audit. Runtime tests and browser outcomes are recorded separately; source inspection does not count as browser acceptance.

## Additional confirmed issues (shared during the browser audit)

| ID | Reproduction and expected behavior | Fix / verification |
|---|---|---|
| BF-7 | Dashboard with unknown days remaining shows a bare label; unknown should be omitted, zero preserved | Null-aware rendering; null/zero/positive regressions |
| BF-8 | Click sortable Score or amount header; order does not change because no caller handles sort | Local stable exact-money/numeric sorting, controlled compatibility, keyboard/aria tests; large integer precision followup |
| BF-9 | Open Targets with real fixture: blank financial fields/status and NaN% | Consume canonical category health contract; unknown progress stays Unknown; exact money and zero tests |
| BF-10 | Project uses invented projections keys while API returns monthlyProjections | Canonical response rendering, explicit warning and Project control; final browser projection verified |
| BF-11 | Intentionally denied Sync displays Unknown error in evidence demo | Fixed safe scenario-restriction message; code-only 403 regression and final browser toast verified |

## Automated validation

- Isolated normal Better Auth + disposable Actual scenario run: 45 families, 73 acceptance tests passed; 13 synthetic fault tests passed. These verify service flows, not complete browser acceptance.
- Complete web suite: 160 files, 2,362 tests passed, none skipped.
- Independent correctness and complexity review performed on shell/review, scenario route, analysis recovery, targets, sorting and Cash Flow changes. Integer-string precision and strict-type issues were found and corrected.
- Targets coverage 100% statements, 94.11% branches; Cash Flow 100% all metrics; web coverage: 85.61% lines overall, 90.76% changed production files; all metric values recorded below.

## Operational observations and limits

LAN readiness reported degraded with workflowStore unavailable; /api/spaces returned retryable GOVERNANCE_UNAVAILABLE. Auth database/migration/configuration checks and workflow path configuration checks reported ok. These checks do not identify a permissions, corruption or migration root cause. No LAN data/configuration was changed.

All browser mutations above used the local scenario supervisor on 127.0.0.1:3313 with separate temporary databases, synthetic credentials, fictional budgets and external research off. No real data was copied into fixtures. Wallet attestation was previewed only; Actual approval/execution remained separate. OCR provider execution remains unverified (synthetic fallback fault coverage only). Native adapter currently lacks populated sinking-fund metadata, so that branch is component-contract coverage.

## Final verification and explicit limits

- BF-11: receipt/evidence scenarios deliberately reject Review Sync with `DEMO_OPERATION_DISABLED`. The UI previously displayed “Unknown error.” It now displays a fixed explanation that Sync is unavailable for the active demo scenario. Code-only HTTP 403 regression and final browser toast verified. No proxy permissions were broadened.
- Final full web coverage run: 160 files, 2,362 passing tests, no skips. Statements 82.74%, branches 79.07%, functions 85.47%, lines 85.61%. Repository coverage gates use line coverage; thresholds were not changed.
- Workspace build, workspace TypeScript, Nuxt typecheck, workspace lint, and diff checks passed. Final evidence catalog/demo reset/isolation run: 69 tests across 3 files passed.
- Independent correctness and complexity reviews found no remaining blocking findings after precision, strict-type and canonical response fixes. All financial computations remain server-owned.
- Browser confirmed keyboard Enter ascending and Space descending sort with `aria-sort` on the header, final Targets values, Cash Flow first-use projection/warning, initial Reports generation, evidence deep-link expansion and explicit demo Sync denial.
- Saved-view save opened a native JavaScript prompt. Supported dialog inspection reported a prompt; accepting the synthetic name timed out, later inspection showed no dialog, and a fresh tab showed no saved view. Persistence was not confirmed. No repeated save was attempted.
- A permitted merchant scenario was selected to verify full Review Sync; the switch started, then browser inspection timed out and JavaScript execution was explicitly denied. No retry or alternative browser access followed that denial. Merchant full Sync, modal/category correction, final no-membership/storage-failure browser recovery, and remaining auth/invitation/proposal/transfer routes are therefore not claimed browser verified.
- Login/setup/invitation, transfer/proposal approval, reconciliation and categorization mutation paths have source/component or authenticated scenario coverage, not a complete manual browser pass. The audit does not constitute full UI acceptance.
- Report output was rendered successfully, but interpretation of its financial result was not independently reconciled against an expected spending calculation in this UI audit.
- The deployed workflow-store readiness failure remains a separate operational issue. No fix to its root cause is claimed; no deployment data or configuration was changed.

## Release gate

This work is prepared for a draft pull request. A human must review and merge. A new beta tag/release is deferred until manual merge is independently verified and the repository checks pass. No beta was installed into a LAN deployment.
