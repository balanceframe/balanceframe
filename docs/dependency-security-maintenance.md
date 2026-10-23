# Dependency security maintenance — 2026-10-18

This maintenance branch starts at `4bdc5e6cece75b3c3ace64cfd1f2f6b28aad35ac`
and preserves the separate `controlled_reallocation` branch and PR #34.
The two leaf upgrades were committed as `051ce22`. The user subsequently approved
groups A–F, the Actual SDK repair, compatible Nitro replacement and pinned forge
backport. A–F, the Forge and Braces interim mitigations, and the Actual Node SDK
Handlebars repair are implemented. The Nitro owner replacement remains blocked
by traversal compatibility; no replacement walker has been applied.

## Editor and Forge follow-up — 2026-10-22

The user approved only Vite **8.3.2 → 8.3.3**, standalone launch-editor
**2.14.1 → 2.14.2** (both MIT), and bounded hardening of the existing Forge
patch. The earlier dated results below describe prior checkpoints. In particular,
the current Forge source adds one condition beyond the upstream-head backport
and therefore no longer matches that upstream file byte-for-byte.

The two package updates address
[GHSA-587h-7wmj-h5pm / CVE-2026-112942](https://github.com/advisories/GHSA-587h-7wmj-h5pm)
and the related
[GHSA-698v-4r3x-3vcv / CVE-2026-112943](https://github.com/advisories/GHSA-698v-4r3x-3vcv).
The former bypasses a Windows editor-path existence check; the latter involves
Windows command-argument percent expansion. Both updates are required because
Vite bundles its own editor implementation, while Nuxt DevTools separately
imports launch-editor. Current Nuxt/Vitest ranges accept the patch releases;
the existing shell-quote 1.11.0 satisfies the new editor dependency range.

The lockfile changes only those version keys/references, their two published
integrities, and the Forge patch hash. Manifests, other package versions and
security patches remain unchanged. Vite 8.3.3 also changes HTML transformation
and development-server file checks, so its compatibility requires build and
application checks in addition to the security regressions.

The Forge patch now rejects nonempty primitive ASN.1 NULL parameters. Two
additional parser regressions failed before hardening and pass afterward;
OID-only, empty NULL, wrong-digest and ordinary RSA signature controls remain
covered. These exponent-one parser probes do not demonstrate a real-key forgery
or prove complete RSA-verification safety. The Node entry remains version 1.4.0;
browser distributions are unchanged and the published advisory remains open.

Twenty editor tests evaluate the installed standalone and Vite-bundled code
with Windows path semantics and captured process calls. They cover path
normalization before existence checks, percent/CR/LF rejection, ordinary paths,
quoting, line/column positions, missing files and UNC paths. Before the updates,
16 security cases failed and four controls passed; after installation all 20
pass. The harness never starts a shell or editor. Portable CI runs these tests,
including on Windows; the full Linux security suite contains **68 tests**.

The saved audit for pre-update head `b3faa0e` reported 19 findings (four high,
13 moderate, two low). Its high-only console identifies Forge, Braces, Vite and
launch-editor; it does not enumerate all lower-severity findings. A fresh
`pnpm audit --json` on 2026-10-23 reports **14 findings: two high, ten moderate,
two low and zero critical**. Vite and launch-editor are absent from that report.
The incomplete older record cannot establish the exact lower-severity advisory
delta. Forge and Braces retain their high advisory flags despite local
mitigations, so the audit still fails. The existing remote CI audit remains
unchanged and nonblocking. Existing Braces guards and all other patches are
preserved; this is not a clean-audit claim.

## Applied and verified

| Package | Previous | Applied | High/critical advisories removed from the lockfile audit |
| --- | --- | --- | --- |
| `shell-quote` | 1.10.0 | 1.11.0 | [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) |
| Standalone `handlebars` | 4.7.9 | 4.7.10 | [GHSA-8r5x-fm3f-whwj](https://github.com/advisories/GHSA-8r5x-fm3f-whwj), [GHSA-p8wg-vrv2-v86f](https://github.com/advisories/GHSA-p8wg-vrv2-v86f) |

In the initial leaf commit, the lockfile changes only those two package keys,
integrities, snapshots and consumer references. Handlebars requires
`minimist ^1.2.8`; the previously locked 1.2.8 already satisfies it. That commit
preserves manifests, overrides and existing patches. Subsequent approved group
changes are described below; security settings are unchanged.

Nine focused tests cover the fixes and normal consumer behavior. The
malicious-input assertions fail against the previous versions and pass against
the approved versions. Tests only construct shell text, inspect compiler
initialization, or stringify a lookup result; they never execute injected shell
text or a returned constructor. The prototype-method permission is enabled only
inside its regression test.

Verification completed:

- Actual adapter: **371 tests**, including four Handlebars tests.
- Web: **1,991 tests**, including five shell-quote tests.
- CLI: **172 tests**; contract: **147 tests**; live Actual: **102 tests** across nine proof files.
- Full workspace build, including a fresh native release build and Nuxt production build.
- Root lint and TypeScript checks, Nuxt typecheck, and strict typechecking of the Handlebars regression file.
- Frozen lockfile installation, exact lockfile-scope comparison and `git diff --check`.

Groups A–F add 16 representative dependency regression/control tests, including
bounded subprocesses for potentially nonterminating inputs and allocation guards
for ZIP probes. The forge backport adds seven malformed/valid-signature tests.
Together with ten Braces guards and 13 embedded-SDK groups, all
**46 dependency-security tests pass**, and CI runs them through
`pnpm test:dependency-security`; the root `test` command includes them too.
These tests cover each affected package, not every individual advisory variant.

The forge patch changes only `lib/rsa.js`. Its complete patched source matches
approved upstream head `f192c67ee5850e44296ef83d6a7b6df6552ba8bf` byte-for-byte.
Three malformed forms fail against the old implementation and pass after the
patch; four version/ordinary-signature controls pass on both. Package version
**1.4.0** is retained, and its advisory remains open. This is the Node entry used
by listhen, not a claim to have rebuilt forge's browser distributions.

Earlier source browser verification passed in real Chromium against Nuxt dev, Vue
3.5.43 and devtools 3.4.3. A real Better Auth owner signed in with both bypass
settings false, selected an explicitly created disposable space/membership and
connected the fixture budget through the UI. Exact budget/account/category read
grants were provisioned only in its private fixture database. The data began with
canonical `representative.json`; live Actual proofs added disposable test records.
Sync returned 200 with 46 review rows and zero failures. The UI displayed the
Starting Balance row at 1038.00 USD, opened Edit, listed Groceries and other
fixture categories, changed Confirm from disabled to enabled after selecting
Groceries, and closed on Cancel. No financial mutation was submitted and no page
or console errors occurred in the completed flow. Initial fixture/setup selector
attempts were corrected before that final run; they are not claimed as passes.
There is no first-party editor UI route to exercise; Tiptap/clipboard changes
have the separate bounded dependency tests. Browser tabs and owned servers are
closed after verification.

Full source coverage, Rust unit suites, remote CI and cross-platform execution
were not repeated for this JavaScript dependency/third-party-patch checkpoint.
This remains a partial security remediation, not release readiness.

## Audit result and runtime limit

Fresh `pnpm audit --json` results, using the same advisory service:

| State | Critical | High | Moderate | Low |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 5 | 29 | 11 | 1 |
| Approved leaf upgrades | 2 | 29 | 10 | 1 |
| A–F plus forge source backport | 0 | 2 | 5 | 1 |
| Braces interim guards checkpoint | 0 | 2 | 5 | 1 |
| Actual Node SDK repair checkpoint | 0 | 2 | 5 | 1 |

No new advisory appeared. Besides the three critical advisories above, the
standalone Handlebars upgrade removes moderate
[GHSA-xw65-4hp5-5hc7](https://github.com/advisories/GHSA-xw65-4hp5-5hc7).
The two remaining high findings are `node-forge` and `braces`; neither interim
source backport removes its published advisory. The audit still fails. The CI audit command currently catches that failure with
`|| echo`; a green workflow step does not establish a clean audit.

**The installed and production Actual Node SDK now embed Handlebars 4.7.10.**
Their main bundles are byte-identical, SHA-256
`1191509c5c629d99bdf6d4d96637c66abb3fe6e11da2428b4cec30d154ea58c7`.
All 13 embedded-compiler tests pass against each copy, without loading the
standalone Handlebars package. The installed SDK also ships its regenerated
source map; Nitro omits that map from its traced production output. No Nitro
settings changed. This is a local patch to API **26.10.0**, not a newly published
fixed API version. Browser distribution and type artifacts are unchanged.

The SDK rule action can compile a truthy template without a runtime string
check. First-party types describe strings, but a complete attacker path to an
AST object was not established. No application setting enabling
`allowProtoMethodsByDefault` was found. Those reachability limits were not used
as an exemption; the Node compiler and runtime regressions are now fixed.

## Approved and applied groups A–F

Frozen installation passed. The precise transform replaces 64 approved targets,
reuses already locked compatible child versions and removes only five unreachable
Git subtree packages. All other package metadata is retained. Published dependency
constraints, package integrities, peer metadata and graph edges were checked.
No additional package version was introduced beyond the approved groups.

| Group | Exact applied changes | Baseline findings targeted | Validation scope |
| --- | --- | --- | --- |
| A — compatible utility updates | `fast-uri 3.1.3→3.1.7`; `brace-expansion 5.0.7→5.0.11`; vulnerable `nanoid 3.3.16→3.3.19`; `tar 7.5.20→7.5.21`; `browserslist 4.28.6→4.28.7`; `source-map-js 1.2.1→1.2.2`; required `baseline-browser-mapping 2.10.43→2.10.44` | 16 high across six roots | Bounded advisory regressions, contract/CLI/web suites, lint/types and production build |
| B — SVG tooling | `svgo 4.0.2→4.1.0`; required `sax 1.6.0→1.6.1`, `css-what 6.2.2→7.0.0`, `css-select 5.2.2→6.0.0` | 1 high | Script-removal bypass regression, ordinary SVG preservation, CSS/icon production build; two transitive major upgrades require explicit approval |
| C — archive reader | Direct web dev dependency `adm-zip 0.5.18→0.6.1` | 5 high | Bounded malformed-ZIP regressions, archive/Nitro packaging tests, full web suite/build; a pre-1.0 minor may change behavior |
| D — editor family | All 37 currently locked `@tiptap/* 3.28.0` packages listed below → **3.30.5**; `prosemirror-view 1.42.1→1.42.3` | 2 high | Markdown-attribute and paste regressions, editor consumer compatibility, full web tests/types/build and relevant browser behavior |
| E — Vue family | `vue` and nine scoped packages listed below, affected 3.5.40 copies → **3.5.43** | 1 high | SSR carriage-return attribute regression, component suites, full web types/build and representative browser flows |
| F — remove the vulnerable Git owner | `@nuxt/devtools`, `@nuxt/devtools-kit`, `@nuxt/devtools-wizard 3.4.2→3.4.3`; required `package-manager-detector 1.7.0→1.8.0`; port/rekey the existing Vite compatibility patch to devtools 3.4.3 | 2 critical + 2 high across `simple-git` and `@simple-git/argv-parser` | Verify both Git packages disappear from the resolved graph, preserve Vite patch behavior, devtools Git analysis and editor parsing, local Nuxt startup, full web suite/types/build |

Group A's parent ranges already accept the proposed versions. Nanoid 3.3.19 is
already locked on an unaffected path. Browserslist requires the additional
mapping update. Group B's new selector majors are explicit rather than hidden
inside an apparent leaf update.

All editor targets exist in the registry. Existing extensions require their
exact matching core version, so upgrading core alone is incomplete. The 37
packages are `@tiptap/` followed by:

```text
core, pm, extension-blockquote, extension-bold, extension-bubble-menu,
extension-bullet-list, extension-code, extension-code-block,
extension-collaboration, extension-document, extension-drag-handle,
extension-drag-handle-vue-3, extension-dropcursor, extension-floating-menu,
extension-gapcursor, extension-hard-break, extension-heading,
extension-horizontal-rule, extension-image, extension-italic,
extension-link, extension-list, extension-list-item, extension-list-keymap,
extension-mention, extension-node-range, extension-ordered-list,
extension-paragraph, extension-placeholder, extension-strike,
extension-text, extension-underline, extensions, markdown, starter-kit,
suggestion, vue-3
```

The enumeration was verified against the baseline lockfile's 3.28.0 family;
all 37 targets now resolve to 3.30.5.

Vue's scoped packages are `@vue/compiler-core`, `compiler-dom`, `compiler-sfc`,
`compiler-ssr`, `reactivity`, `runtime-core`, `runtime-dom`, `server-renderer`
and `shared`. Some compiler/shared 3.5.43 copies already exist and stay aligned.
Metadata checks found no additional mandatory dependency or peer versions for
groups C–F beyond their enumerated targets.

Devtools 3.4.3 removes `simple-git` and uses `tinyexec ^1.3.0` for fixed Git
read arguments; existing 1.3.1 satisfies that range. Nuxt 4.5.2 accepts devtools
`^3.4.1`. The existing Vite patch applies in a dry run with a line offset; it
must be retained, not discarded. A direct `simple-git 4.0.1` override is a
worse candidate: its published dependency still pins vulnerable
`@simple-git/argv-parser 2.0.0`, and it crosses an owner major boundary.

## Interim mitigations and SDK rebuild provenance

No published patched version exists for
[`node-forge <=1.4.0`](https://github.com/advisories/GHSA-86w9-cpqp-85rv) or
[`braces <=3.0.3`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), one high
advisory each. Current latest owner metadata still reaches the same vulnerable
packages. A blind Nuxt/Nitro upgrade is not an established fix.

- `node-forge`: the approved backport of the still-unmerged
  [upstream RSA verification fix](https://github.com/digitalbazaar/forge/pull/1158)
  at head `f192c67ee5850e44296ef83d6a7b6df6552ba8bf` is applied and locally
  verified as an interim mitigation. The published 1.4.0 audit finding stays open.
  For actual package removal, Nuxt CLI → listhen's certificate generation,
  CA signing, encrypted keys and PFX parsing all need compatible replacements.
  Merely substituting `selfsigned 5.5.0` would not preserve those interfaces.
  Native Node TLS can consume PFX, but changing the returned HTTPS configuration
  needs caller/type review and key, SAN, expiry, PFX and real HTTPS tests.
  No complete replacement or production attacker-controlled signature path
  was established. No new certificate dependency is proposed for approval yet.
- `braces`: Nitro → globby → fast-glob → micromatch uses its pattern parser.
  The approved compatible owner replacement is paused: direct `tinyglobby 0.2.17`
  substitution fails actual differential probes. `['**','!a.js','a.js']` loses
  re-inclusion; negative-only arrays become empty; explicit static ordering and
  `./` path spelling change; `{1..5..2}.js` matches `1,2,5` rather than `1,3,5`;
  negated ignore entries differ; unreadable paths and a file-valued cwd silently
  return incomplete/empty results where globby rejects. A segmentation adapter
  alone is insufficient. Preserving the nine call contracts requires additional
  brace expansion, ordering/path handling and filesystem error propagation.
  The user approved a bounded adapter with fixed `brace-expansion 5.0.11` and
  a filesystem-error wrapper on 2026-10-18. Investigation stopped before
  implementation at the required cyclic-symlink compatibility gate. On a real
  disposable Linux fixture containing `a.js` and `loop -> .`, globby returns
  41 lexical file paths (through 40 loop components); tinyglobby returns two.
  Independent probes reproduce this across all nine call-site forms.
  Tinyglobby's fdir walker privately prunes repeated resolved ancestors after
  successful filesystem calls. An error wrapper cannot restore the missing
  paths; disabling symlink following also changes the contract. Preserving
  those results would require traversal emulation or bypassing that pruning,
  exceeding the approved small adapter. No replacement was applied.
  No attacker-controlled production glob path was established. Every remaining
  braces owner must disappear before claiming removal. Native Windows
  compatibility remains unverified; Linux cyclic-symlink parity failed.
  The user subsequently approved an interim mitigation preserving this walker.
  The applied Braces 3.0.3 patch derives only the five depth/cycle guard files
  from contributor commit `28d440b5dd449dbf1fe6f3506cf94ecca4d02660` in closed,
  unmerged [braces PR 72](https://github.com/micromatch/braces/pull/72):
  `lib/constants.js`, `parse.js`, `compile.js`, `expand.js` and `stringify.js`.
  Unrelated quote/comma parser changes are excluded. It deliberately rejects
  combined brace/parenthesis or AST nesting above 100 and detects expansion
  parent-chain cycles. No package version, walker, dependency or lifecycle
  permission changes. Its published advisory stays open; this is not a claim
  to eliminate every denial-of-service form or establish a production attacker
  path. Native Windows execution remains unverified.

  Direct-AST stack overflow and parent-cycle timeout baselines reproduce; a
  string-overflow observation was not repeatable and is not an asserted gate.
  Ten permanent regression/control tests pass against the installed Nitro
  dependency chain. The upstream 3.0.3 suite passes all 764 tests on both baseline
  and patch with no skips; 1,350 ordinary comparisons, 126 boundary controls and
  38 consumer gates preserve all nine Nitro forms, error behavior, path spelling
  and Linux cyclic-symlink path sets. Native asynchronous directory order varies
  even between baseline runs; exact array comparisons use a deterministic
  filesystem adapter, rather than claiming native concurrent order equivalence.
  Combined changed-file coverage is 94.59–100% lines and 91.53–100% branches.
  Independent correctness and complexity reviews found no in-scope issues.

  Patch SHA-256 is
  `1418a3f2c7e9ea91706b108614e903178c8bb035ad6a1c84a93dc2e3496bb73e`.
  Two incremental frozen installs linked a patch context but skipped its build
  node, leaving original bytes. Both patch formats apply correctly in pnpm's
  actual patch engine; graph reconstruction identified the skipped transitive
  build node. Standard `pnpm install --force --frozen-lockfile --offline` with
  the existing store rebuilt the complete graph successfully. Installed runtime
  bytes and unchanged globby/fast-glob/micromatch sources were independently
  checked. The permanent tests resolve the actual installed dependency, so
  merely linking an unapplied patch cannot pass acceptance.

  This checkpoint also passes root lint/types, Nuxt typecheck, all 1,991 web,
  371 adapter, 172 CLI and 147 contract tests, plus the full workspace build
  including native release compilation and Nuxt production output. The
  production SDK was unchanged at that checkpoint; its subsequent embedded
  Handlebars repair is described below.

  Fresh source-browser verification also passed in Chromium using a newly
  seeded canonical fixture, an isolated space and a real Better Auth owner
  with both bypass settings false. Explicit budget selection and Sync returned
  200; 46 review items included Starting Balance at 1038.00 USD with zero sync
  failures. Edit initially disabled Confirm, listed Groceries among 23 category
  options, enabled Confirm after selecting it, and closed on Cancel. No
  financial write request, page error or console error occurred. Initial
  private-fixture identity/bootstrap and anonymous-denial assertion attempts
  were corrected and retained separately; they are not claimed as passes.
- Embedded Handlebars: the approved Node-only rebuild is applied. Official npm
  provenance identifies Actual source commit
  [`2bebdbaae0b701120a8cad9d56aafd64fa04c577`](https://github.com/actualbudget/actual/tree/2bebdbaae0b701120a8cad9d56aafd64fa04c577).
  Its original lock SHA-256 is
  `0326284066b6f9f9297c671eb792b034f4435cb26c8b5bfbc89fb7fa5aebb5f9`.
  The isolated projection retains 521 exact underlying external resolutions,
  four selected source workspaces and all 15 workspace records; 11 non-selected
  manifests have their dependencies cleared. The earlier 516-record draft
  omitted five official patch-resolver prerequisites and is not used.
  Node 24.19.0, the checked-in Yarn 4.17.1 CLI, Vite 8.1.5 and Rolldown 1.1.5
  remain pinned. Source, CLI, configuration, lifecycle restrictions and the
  frozen 4,204-file/five-symlink projection were checked independently.

  The initial immutable install stalled in Fetch. The parent authorized
  command-local selection of the environment's existing proxy for Yarn;
  its value was never logged or persisted. The retry passed in 22.136 seconds.
  No proxy service, destination, TLS/CA, DNS, registry, authentication, global
  configuration or hook trust changed. SQLite's build remained explicitly
  disabled. A small generated-layout correction places existing source-map
  0.6.1 at the root and 0.7.6 beneath rollup-plugin-visualizer, preserving both
  declared consumer versions and package bytes. Only two generated Yarn
  location entries change. This removes an otherwise explained difference in
  region-comment paths without editing emitted output.

  Running the unchanged Node Vite command from the snapshot root reproduced
  all 65 published Node artifacts exactly, twice, including main SHA-256
  `fdfed936dac6ba6dc411bac27f94237a90c8cb0ea047a5d9d0d8a5d21ea9aa56`
  and map SHA-256
  `756a96361b4d16132e6f19e2f052c254be01bcd45c7ac943be6630ec714ec36d`.
  Baseline bytes were accepted before the Handlebars substitution.

  The separate Handlebars 4.7.10 candidate changes only its exact lock record
  and the minimist descriptor from `^1.2.5` to `^1.2.8`; already locked minimist
  1.2.8 is reused. All 520 other external records/checksums and 15 workspace
  records remain exact. All 118 target package files match retained published
  integrity data. Stock Yarn checksum preparation skips linking; the reviewed,
  frozen candidate then passes stock immutable installation in 7.515 seconds.
  No new package fetch or build script runs in that final install. Normal Yarn
  cleanup removes the unused old Handlebars cache archive; protected source
  files and symlinks remain unchanged. Target lock SHA-256:
  `1f507874abc3d901b01384fa28c759df3f669e9a7130952e46480970fbf632c8`.

  Two corrected Node builds produce identical 65-artifact sets. Only main and
  map differ from baseline; all differences are in 13 Handlebars module/source
  regions, including its new node-types module. Other 63 artifacts and all
  non-Handlebars source content remain exact. The final pnpm patch includes
  the rebuilt main, the exact existing `rows.flatMap` grouped-query fix, and
  the regenerated map. Its roughly 16.2 MB text size comes from replacing the
  existing single-line map; no custom installer or loader is introduced.
  Patch SHA-256:
  `04bc33c3160b56ef048a37f6f62fbca81635824106f6a58eb175ac9a68dd41d6`.
  Map SHA-256:
  `e05a06fd3f235a035c5129d4a3a1009a2725c2385763da8ac185eda483ba895d`.
  The inherited manual query-line change retains its pre-existing local
  source-map column limitation; all rebuilt Handlebars mappings are updated.
  Browser and type outputs are intentionally unchanged.

  The patch uses ordinary unified text. Equal deletion/insertion pairs encode
  tab-indented context so repository whitespace checks pass without changing
  runtime bytes. Git reproduction uses `git apply --unidiff-zero`; pnpm's
  actual patch engine and frozen offline installation produce all 89 expected
  package payload files exactly. Root manifest/settings remain unchanged and
  the lock changes only six API patch-hash references.

  Thirteen embedded-compiler groups reproduce 11 failures and two passing
  controls on the accepted old baseline, then all pass on installed and
  production entries. They cover malformed AST fields, option paths, escaping,
  prototype constructors, partials, iterator cleanup and ordinary behavior.
  Malformed ASTs are not rendered and returned constructors are not invoked.
  Standard V8-to-Istanbul measurement on added/replaced line locations within
  the 13 changed Handlebars CJS sources gives **93.16% lines, 93.28% statements,
  100% functions and 87.96% branch arms**. This is changed-code coverage, not
  whole-bundle or whole-workspace coverage; no suppression was added.

  Root security (46), web (1,991), adapter (371), CLI (172), contract (147) and
  live Actual (102) tests pass, along with lint, root/Nuxt types and the full
  workspace/native/Nuxt production build. A read-only canonical split query
  returns parent -8000 and children -5000/-3000, preserves matching/unmatched
  flags and returns an empty set for an absent amount. Independent correctness
  and complexity reviews accept source, package scope and installed bytes.

  Fresh Chromium source verification of the repaired SDK also passes with real
  Better Auth and both authentication bypasses disabled. A new isolated space
  explicitly selects the disposable budget after the live suite; this fixture
  is no longer pristine. Sync returns 200 with 46 created/transitioned items
  and zero failures, including Starting Balance at 1038.00 USD. Groceries is
  present among 24 category options (23 fixture categories plus Uncategorized);
  selecting it enables Confirm, and Cancel closes the dialog. No financial
  write request or page/console error occurs. Browser contexts and both owned
  servers are closed, ports 5396/5397 are closed, and the generated fixture
  environment file is removed. No product changes were needed for verification.

Do not suppress these advisories, rename a vulnerable package to conceal it,
weaken audit checks, or claim a clean audit from an unverified source patch.

## Complete high/critical root inventory

The baseline contains **34 high/critical advisories across 17 package roots**.
Repeated paths are deduplicated by advisory, not counted as separate defects.
The table below accounts for every root; the embedded copy is an additional
delivery of Handlebars, not another registry audit entry.

| Root | Critical | High | Disposition |
| --- | ---: | ---: | --- |
| shell-quote | 1 | 0 | Applied leaf upgrade |
| handlebars | 2 | 0 | Standalone upgrade and embedded Node SDK repair applied; browser distribution unchanged |
| fast-uri | 0 | 7 | A |
| brace-expansion | 0 | 4 | A |
| nanoid | 0 | 1 | A |
| tar | 0 | 1 | A |
| browserslist | 0 | 2 | A |
| source-map-js | 0 | 1 | A |
| svgo | 0 | 1 | B |
| adm-zip | 0 | 5 | C |
| @tiptap/core | 0 | 1 | D |
| prosemirror-view | 0 | 1 | D |
| @vue/server-renderer | 0 | 1 | E |
| simple-git | 1 | 2 | F |
| @simple-git/argv-parser | 1 | 0 | F |
| node-forge | 0 | 1 | Approved interim backport applied; published advisory remains open |
| braces | 0 | 1 | Approved five-file interim guards applied; published advisory remains open |

Tooling reachability is not a blanket exemption. The editor and Vue packages
can run in browsers; the app uses `ssr: false`, which alone does not remove all
Vue dependency paths. Adm-zip's only first-party import found is a packaging
test. Fast-uri's representative path is contract validation through Ajv;
brace-expansion and browserslist are build/lint tooling. Complete hostile-input
reachability was not established for those transitive paths.

Raw audit JSON, exact registry metadata, dependency constraints, source
inspection and verification logs are retained in the saved environment under
`/workspace/.setup/dependency-maintenance-evidence/`. Remote publication,
merging and deployment are not authorized for this maintenance branch.
