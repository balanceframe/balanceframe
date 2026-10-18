# Dependency security maintenance — 2026-10-18

This maintenance branch starts at `4bdc5e6cece75b3c3ace64cfd1f2f6b28aad35ac`
and preserves the separate `controlled_reallocation` branch and PR #34.
The two leaf upgrades were committed as `051ce22`. The user subsequently approved
groups A–F, the Actual SDK repair, compatible Nitro replacement and pinned forge
backport. A–F, the forge mitigation and the subsequently approved Braces interim
mitigation are implemented. The SDK repair is blocked during immutable package
fetching; the Nitro owner replacement remains blocked by traversal compatibility.
Neither blocked replacement has been applied.

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
Together with ten Braces guards, all **33 dependency-security tests pass**, and CI runs them through
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

No new advisory appeared. Besides the three critical advisories above, the
standalone Handlebars upgrade removes moderate
[GHSA-xw65-4hp5-5hc7](https://github.com/advisories/GHSA-xw65-4hp5-5hc7).
The two remaining high findings are `node-forge` and `braces`; neither interim
source backport removes its published advisory. The audit still fails. The CI audit command currently catches that failure with
`|| echo`; a green workflow step does not establish a clean audit.

**The production Actual SDK still embeds Handlebars 4.7.9.** The installed and
Nuxt production copies of `@actual-app/api/dist/index.js` are byte-identical,
SHA-256 `adcce45c12250e9deef666632a33c0edb6b0e8988c79a13ddc0a90a9566c7269`.
Updating the standalone dependency does not repair that bundled copy. The
current published API release is still 26.10.0; no verified fixed release was
found. The SDK's rule action can compile a truthy template without a runtime
string check. First-party types describe strings, but a complete attacker path
to an AST object has not been established. No application setting enabling
`allowProtoMethodsByDefault` was found. These limits do not constitute a fix or
an exemption.

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

## Blocked remaining work and additional scope decisions

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
  production SDK hash remains unchanged; its embedded Handlebars issue below
  is still unresolved.

  Fresh source-browser verification also passed in Chromium using a newly
  seeded canonical fixture, an isolated space and a real Better Auth owner
  with both bypass settings false. Explicit budget selection and Sync returned
  200; 46 review items included Starting Balance at 1038.00 USD with zero sync
  failures. Edit initially disabled Confirm, listed Groceries among 23 category
  options, enabled Confirm after selecting it, and closed on Cancel. No
  financial write request, page error or console error occurred. Initial
  private-fixture identity/bootstrap and anonymous-denial assertion attempts
  were corrected and retained separately; they are not claimed as passes.
- Embedded Handlebars: rebuilding official Actual 26.10.0 with Handlebars 4.7.10
  and its isolated 516-entry build closure were approved on 2026-10-18.
  Official npm provenance identifies source commit
  [`2bebdbaae0b701120a8cad9d56aafd64fa04c577`](https://github.com/actualbudget/actual/tree/2bebdbaae0b701120a8cad9d56aafd64fa04c577).
  Its immutable [yarn.lock](https://raw.githubusercontent.com/actualbudget/actual/2bebdbaae0b701120a8cad9d56aafd64fa04c577/yarn.lock)
  has SHA-256 `0326284066b6f9f9297c671eb792b034f4435cb26c8b5bfbc89fb7fa5aebb5f9`:
  2,730 external entries and 15 workspaces, not a verified minimum API closure.
  A smaller metadata-derived API focus closure contains **516 external entries
  and four workspaces**: API, core, CRDT and vite-plugin-peggy. All descriptors
  resolve using the unchanged lock and its existing resolution rules; optional
  platform variants are included. Its exact receipt has SHA-256
  `80a318fb302a50cf6172471b3df6fb156c9c1f7dfbb1d0b2d1fdac7daeb39c5a`.
  Relevant pinned tools include Yarn 4.17.1, Vite 8.1.5, Rolldown/native binding
  1.1.5, `@oxc-project/types` 0.139.0, Vitest 5.0.0, Peggy 5.1.0, visualizer 7.0.1,
  Lightning CSS 1.32.0 and TypeScript native preview 7.0.0-dev.20260421.2.
  An isolated focus attempt was stopped before materializing packages. The
  proposed command did not enforce immutability: Yarn 4.17.1's focus command
  forwards only cache and `persistProject: false` to installation, whereas its
  install command explicitly forwards `immutable` from configuration. Setting
  `YARN_ENABLE_IMMUTABLE_INSTALLS=true` does not supply the omitted focus option.
  This corrects the earlier metadata-only plan's assumption; an unchanged
  on-disk lock is not proof of immutable resolution. Source and checked-in CLI
  inspection plus an executable check of the extracted option expressions
  establish the missing option; this was not a full runtime install trace.
  A strictly frozen installation mechanism is still required before proceeding.
  The attempt also stalled without report output; a Node HTTPS probe timed out
  while curl reached the registry. Its exact stall location is unproven; no
  network settings or lifecycle restrictions were changed. The process was
  stopped successfully, with zero cached package ZIPs, no `node_modules`, and
  all 18 source manifests, lock, configuration and CLI bytes unchanged.
  Official npm integrity checks passed; the unpatched published Node bundle
  SHA-256 is `fdfed936dac6ba6dc411bac27f94237a90c8cb0ea047a5d9d0d8a5d21ea9aa56`.
  No baseline build or Handlebars substitution was attempted, so baseline
  reproducibility has not been disproved or established. Preserve current Node
  24.19.0, lifecycle restrictions and application/global settings. Stop on any
  resolution outside the enumerated closure. First reproduce official baseline
  bytes; then freeze every other
  resolution, build the correction twice and explain all differences.
  Preserve the existing grouped-query patch and verify embedded regressions,
  ordinary rules/templates, grouped queries and installed/production bytes.

  A disposable focused manifest/lock projection was subsequently authorized
  as an implementation method and prepared for independent review only.
  It preserves all 4,204 source files; only 11 non-selected manifests and the
  lock differ. The four selected manifests, CLI, configuration and source
  patches remain byte-identical. All 516 listed external records retain exact
  fields and checksums, and the extracted pinned serializer round-trips the
  full official lock byte-for-byte. These checks do not execute resolution.
  Independent review found that the original 516-entry receipt omitted
  resolver prerequisites. The pinned patch resolver needs the unpatched
  `vite-plugin-node-polyfills@npm:0.28.0` source archive; built-in compatibility
  hooks additionally need patch records for `fsevents 2.3.2`, `fsevents 2.3.3`,
  `resolve 1.22.11` and `typescript 5.4.5`. All five records already exist in
  the official lock; no new package name, version or transitive package was
  identified. Dependency edges, root resolution rules, built-in compatibility
  transformations and patch-source edges statically reach 521 external
  records; no matching built-in package extensions were found. Exact-516 and
  the intermediate 517-entry draft are therefore ineligible. The required
  inventory correction is consolidated for the orchestrator; no installation,
  fetch, linking or build ran, and full immutable-install compatibility remains
  unverified. Preserve the failed drafts as review evidence rather than
  silently widening their frozen inventories.

  The orchestrator then authorized the corrected 521-record projection.
  It was prepared and independently reviewed: all 521 external records and
  656 descriptor aliases match the official lock and pinned resolver hooks;
  all 4,204 regular files and five symlinks were checked, with only the 12
  intended projection changes. The corrected helper has six passing tests,
  including three regressions reproduced against its earlier implementation.
  Frozen lock SHA-256:
  `4ef68cca229f0cbffa9bb3e142be4568430823781bd5b65c86426103950c8db0`.
  One unmodified `yarn install --immutable --json` attempt completed resolution
  but rejected the lock with `YN0028` before fetching or linking. Its sole
  proposed change removes two lines of generated optional metadata for
  `glob-hasher-linux-arm64-gnu` from the non-selected root workspace record.
  The root's optional dependency edge had been cleared, while the projection
  copied this derived metadata from the original lock. No external record or
  package version change was proposed. The process exited 1 in 0.466 seconds;
  this was neither a timeout nor an access denial. All frozen source/lock bytes
  and symlinks remain unchanged, with zero cached archives and no `node_modules`.
  Work stopped at that unexpected-lock-delta gate; the parent then approved the
  two-line metadata correction and independent handling of projection-only
  normalizations preserving the approved external inventory and controls.
  The corrected helper has eight passing tests, including generated-metadata
  regressions. All 521 external records/checksums and 656 aliases remain exact;
  source files, selected manifests, CLI, configuration and symlinks are frozen.
  Normalized lock SHA-256:
  `41771ccac3d8af7bd2af92fa9d9d1a162bd4135738f9fcbeb96a8bd9ced29040`.

  One stock `yarn install --immutable --json` retry passed resolution and
  immutable validation, then timed out during Fetch after 90.016 seconds.
  It terminated cleanly with no cached ZIPs, no root `node_modules` and all
  frozen hashes unchanged, independently verified. No baseline build,
  Handlebars substitution or repeated corrected builds have run. This is a
  fetch-stage timeout, not a demonstrated access denial or reproducibility
  failure. Read-only matched probes found curl GET reached the registry (200),
  while Node HTTPS failed DNS with `EAI_AGAIN`. Pinned Yarn uses its own agents
  and does not automatically consume the existing standard proxy environment.
  This is consistent with a transport mismatch; the precise stalled Yarn
  request is unknown. No proxy, DNS, TLS, registry, authentication, lifecycle,
  CLI or global settings were changed. Further transport configuration needs
  parent authorization before another bounded immutable retry.

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
| handlebars | 2 | 0 | Applied standalone upgrade; embedded copy unresolved |
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
