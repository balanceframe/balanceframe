# Phase 11.5 implementation status

The authoritative scope remains
[Transaction Evidence and Intelligent Resolution](11-5-transaction-evidence-and-intelligent-resolution.md).
This feature branch is in progress. It is not a completed v0.9.0 release.

| Area                     | Current implementation                                                                                                                                                                                                                           | Remaining acceptance                                                                                                                              |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| Contracts                | Versioned Rust, N-API, TypeScript/Zod, JSON Schema, and canonical fixtures                                                                                                                                                                       | Contract and source/execution coverage gates verified                                                                                             |
| Evidence persistence     | Scoped immutable extraction, private delivery identity, encrypted raw bytes, retention/deletion, audit, restore quarantine                                                                                                                       | Scoped lifecycle, independent review and coverage verified                                                                                        |
| Deterministic resolution | Exact allocations, matching candidates, pending/posted supersession, ambiguity, wallet continuity, receipt/tender validation, projection hashes                                                                                                  | Scoped review, 355 scenarios and real-SDK integration verified; no live-provider acceptance                                                       |
| Ingestion                | Camera/photo upload with local preview, manual PDF receipt normalization, optional unverified manual summary/items/split tenders, optional local OCR text, local wallet/retail JSON, retained binary sources, exact pending Spend Session import | Optional container build verification and broader source coverage; email forwarding explicitly deferred by the user                               |
| Review                   | Focused purpose/match decisions; one-to-many and many-to-many receipt-line matrices across existing settlements; camera return/order/member review; reviewed invoice versions                                                                    | Governed plural SDK recovery and final coverage verified; authenticated browser verification remains blocked                                      |
| Actual integration       | Ordinary governed debit/credit/amendment pipeline, exact source hashes, metadata-preserving reread, explicit opening equity and read-only uncertain recovery                                                                                     | Coverage verified; matrix destinations currently require existing Actual outflow settlements                                                      |
| Wallet balances          | Exact fresh human-attested statements, scoped identity/activity, native interval coverage/conflicts/boundary anchors, governed nonzero opening equity, durable account identity                                                                  | Scoped review/component/API verification complete; authenticated browser remains blocked; never provider-authenticated                            |
| Learning                 | SKU/UPC, approved item, retailer label, department, product-family and approved historical token-similarity tiers; scoped rule simulation/approval                                                                                               | Approved receipt-item model boundary implemented with synthetic providers; production providers remain unconfigured; manual entry stays available |
| Health                   | Authorized receive/parse timestamps, template diagnostics, duplicates, native statement coverage/continuity with balance-state/gap warnings, stale reviewed receipt history in unified attention                                                 | External freshness and notification-based missing-event inference need an approved integration                                                    |

Rust derives explicit receipt-line matrices, including a $12 receipt across
$7/$5 payments and a true two-by-two item/payment allocation. Exact line and
target capacities, graph funding, tenders, source hashes and per-output effects
must agree. Non-bank tender remainders remain visible. Native publication has
bounded output amplification and serialized-size limits. The browser supplies
explicit cells and selections, never balancing adjustments. Saving changes
evidence only; ordinary independent approval and Actual reread remain required.
The clean real-SDK plural flow passes through ordinary proposal creation,
independent approval, both amendments, lost acknowledgement, expired read-only
recovery and idempotent recheck. It preserves cash, parent identity and metadata,
and exact child splits/identities. Its private budget deletion and absence check
pass. Current capture-clock validation applies before both recovery branches;
private historical replay must preserve both source-hash modes and the evidence
hash. Native future-capture and expired-dispatch regressions remain enforced.

Camera receipts support explicit return-to-original, order/fulfillment and
membership-period reviews. Native return capacity is shared across active
refunds; overlinked returns can be cleared. Receipt/invoice replacement uses
append-only, exact source-bound human review. Only independently readable
predecessors enter inactive native history. Stale or revoked predecessor
authority withdraws affected child evidence and creates focused attention;
unrelated receipts remain usable. Immutable extraction is never edited.
Scoped compatibility, integrity and complexity reviews pass. Legacy JSON-declared
receipt histories still fail the combined resolution closed when a declared
predecessor is unavailable; they do not receive the reviewed-link isolation
behavior. Source coverage passes; environment-dependent acceptance remains open.

Saved Spend Session imports preserve exact versions, pending prices and a
server-admitted immutable intent archive. An explicit receipt comparison now
reviews item mappings, substitutions, omitted/new items and partial/unknown
coverage in Rust. Associations require fresh human confirmation and current
source/version authority; a receipt cannot be reserved by two different sessions
for the same owner. Existing completion references remain separately authorized.
This is comparison-only evidence: it does not complete a session, create a
financial claim, or mutate Actual. A planned amount must never be promoted to
settled money to make matching succeed. Reconciliation uses explicit comparisons
rather than automatic session completion. Authenticated browser validation
remains open.

## Approved scope decisions

1. **Camera first:** the user directed camera/photo upload first and email
   forwarding later. Email parsing/receiving remains a deferred Phase 11.5
   requirement, not a completed feature. No live account access, receiver,
   credentials, deployment, or external evidence transmission is authorized.
2. **Optional local OCR:** the user approved Tesseract 5.5.3 (Apache-2.0),
   Leptonica 1.87.0 (BSD-2-Clause), and English tessdata_fast 4.1.0
   (Apache-2.0), with an explicit installation boundary. The separate
   `compose.ocr.yaml` service/profile is opt-in and disabled by default. Core
   startup and health never depend on extraction. Camera upload and manual
   entry remain available when OCR is absent, offline, failing, or busy. No
   npm runtime dependency or cloud OCR provider was added. See
   [OCR setup and verification](../../receipt-ocr.md).
3. **Consequential actions:** the user approved extending the existing typed
   pipeline with exact credits/refunds and existing-settlement amendments.
   Application, adapter, native and real-SDK synthetic tests pass with scoped
   independent review and source coverage. This does not authorize
   live financial writes or an alternate mutation path.

4. **Human-attested statements:** the user approved local proof bound to exact
   source contents/identity, scoped wallet/currency, interval/balances and activity
   manifest, fresh review and invalidation. Imported JSON cannot grant authority.
5. **Opening equity:** the user approved typed nonzero opening balances through
   the existing writer, independent approval, Actual starting-balance reread and
   opening/account-balance postconditions. Income/refund semantics are excluded.
   These approvals cover code and synthetic tests only. See the
   [accepted wallet ADR](../../adr/0005-wallet-proof-authority-options.md).

6. **Optional receipt inference:** the user approved distinct receipt subjects and
   independently authorized local/external paths for code and synthetic tests.
   No provider connection, real-data egress, package addition or enabling of
   inference is included.

Receipt-item inference now implements the [accepted inference ADR](../../adr/0006-receipt-inference-subject-and-egress-proposal.md): a separate typed subject,
strict label/category-alias payloads, deterministic-first local/external preview,
independent permissions and three policy opt-ins, durable single-use consent,
shared quotas, scoped cache/audit, asynchronous revalidation and manual fallback.
Production composition registers no receipt providers or installation opt-in.
Synthetic tests exercise the boundary; no provider is connected and no real
receipt is transmitted. Browser acceptance remains blocked by the existing
sandbox limitation, independently of component/API verification.

## Verification evidence so far

- Regression-first native, application, store, HTTP, CLI, and component tests
  cover implemented behavior. Independent correctness and complexity findings
  have scoped fixes and verification, including receipt null-clear recovery,
  exact wallet boundaries, unrelated-wallet isolation, bounded allocation
  publication and current-versus-historical recovery clocks.
- The complete production workspace build, root/application/store/web types,
  zero-warning TypeScript lint, all-target Clippy, frozen offline install and
  46 dependency-security tests pass. Web types pass with the CI-sized 4 GiB
  heap after bounding recursive proposal-schema inference. The final workspace
  build, root/application/store/web typechecks and zero-warning lint were rerun
  successfully after the PDF, health and contract-loader fixes.
- Exact photo line/tender entry preserves explicit quantity, gross, discount,
  tax, net and tender amounts. Unknowns stay unknown; an application-to-native
  regression confirms mismatches are retained and block projection. Complete
  evidence JSON bodies are bounded to 16 MiB, OCR requests to 7 MiB, and receipt
  collections to 1,000 lines / 100 tenders across Rust, Zod and JSON Schema.
- Disposable real Actual 26.7.0 / SDK 26.10.0 tests verify credits, settlement
  splits, imported metadata preservation, stale-source refusal and lost-write
  acknowledgements followed by read-only proof. Their own synthetic budget is
  deleted and its absence verified. No production budget is involved.
- Final reports contain **962 Rust tests and 6,394 Vitest tests**, all passed,
  with no ignored/pending tests, plus the native binding, real CLI entrypoint
  and 28 coverage-tool tests. All source and changed-source thresholds pass:
  workspace 91.05%, financial core 95.64%, core protocol 96.25%, N-API 93.56%,
  and generated protocol 96.83%. The collected native profiles include real
  instrumented N-API consumers.
- Before the receipt-inference addition, the serial coverage command passed the full scenario/store/SDK stages, then
  stopped on three older contract loaders missing the new schema dependency.
  A shared local-only registry and all-roots/all-definitions regression repaired
  that closure without weakening validation. All 176 contract tests were rerun.
  After the final PDF/health fixes, the complete application (1,476) and web
  (2,160) coverage suites were rerun; the standard CLI/coverage-tool tail and
  Rust reports completed from the collected profiles. The unchanged checker
  passes with required execution evidence. This was a resumed gate, not a
  second monolithic rerun after those final fixes.
- The approved receipt-inference addition reran all four affected suites with
  coverage: application 1,496; web 2,165; workflow-store 1,003; inference 246
  (4,910 tests). Existing unchanged suite/native reports supply the remaining
  execution evidence. The unchanged checker passes all overall/changed-source
  thresholds. Root/application/web types, production build and zero-warning lint
  pass again. Independent correctness and complexity review closed local-first
  dispatch and long-history journal findings with regressions. No Rust source or
  packages changed in this addition.
- The release native resolver's synthetic unmatched-history check completed
  100 / 1,000 / 5,000 observations in 2.6 / 23.45 / 166.7 ms on this executor.
  This is a focused regression measurement, not full-path performance acceptance.
- A disposable **BalanceFrame Test Budget**, source Nuxt, and genuine Better
  Auth session with development bypass disabled verified Sync, encrypted local
  import, exact evidence grants, native resolution, and unified attention through
  HTTP. This is API evidence, not end-to-end browser verification.
- Chromium could not start with its sandbox: the installed SUID helper is owned
  by `nobody`, and the user-namespace fallback reports no usable sandbox. Browser
  sandboxing was not disabled. Live browser acceptance remains blocked by the
  execution environment.
- Nix is unavailable in the saved executor, so the flake checks were not run;
  no Nix source changed. The existing research-Compose contract also rejects
  this renderer's normalized `bind: {}` for an explicitly disabled
  `create_host_path`; its integrity assertion was preserved. These checks
  remain open rather than being replaced with weaker assertions.
- The pinned local OCR engine extracted a synthetic PNG through its HTTP
  boundary with the exact source hash and no remaining temporary files.
  Container builds failed before compilation because BuildKit could not resolve
  `deb.debian.org` on either default or host build networking. This is not a
  verified Docker image. The core-only and opt-in Compose boundaries have
  automated tests.

The release and authoritative roadmap exit must not be marked complete
until the remaining acceptance criteria and validation gates are resolved.
