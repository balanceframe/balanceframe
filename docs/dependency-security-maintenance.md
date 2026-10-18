# Dependency security maintenance — 2026-10-18

This maintenance branch starts at `4bdc5e6cece75b3c3ace64cfd1f2f6b28aad35ac`
and preserves the separate `controlled_reallocation` branch and PR #34.
Only the two explicitly approved leaf upgrades below are applied. Every other
package change in this document is a proposal awaiting approval.

## Applied and verified

| Package | Previous | Applied | High/critical advisories removed from the lockfile audit |
| --- | --- | --- | --- |
| `shell-quote` | 1.10.0 | 1.11.0 | [GHSA-pqg4-j6r4-53mv](https://github.com/advisories/GHSA-pqg4-j6r4-53mv) |
| Standalone `handlebars` | 4.7.9 | 4.7.10 | [GHSA-8r5x-fm3f-whwj](https://github.com/advisories/GHSA-8r5x-fm3f-whwj), [GHSA-p8wg-vrv2-v86f](https://github.com/advisories/GHSA-p8wg-vrv2-v86f) |

The lockfile changes only these two package keys, integrities, snapshots and
consumer references. Handlebars now requires `minimist ^1.2.8`; the previously
locked 1.2.8 already satisfies it. Manifests, overrides, existing patches and
security settings are unchanged. A frozen installation succeeds.

Nine focused tests cover the fixes and normal consumer behavior. The
malicious-input assertions fail against the previous versions and pass against
the approved versions. Tests only construct shell text, inspect compiler
initialization, or stringify a lookup result; they never execute injected shell
text or a returned constructor. The prototype-method permission is enabled only
inside its regression test.

Verification completed:

- Actual adapter: **371 tests**, including four Handlebars tests.
- Web: **1,991 tests**, including five shell-quote tests.
- Full workspace build, including a fresh native release build and Nuxt production build.
- Root lint and TypeScript checks, Nuxt typecheck, and strict typechecking of the Handlebars regression file.
- Frozen lockfile installation, exact lockfile-scope comparison and `git diff --check`.

No UI behavior or financial implementation changes in this slice. Browser and
Rust unit suites were not repeated for these two JavaScript leaf upgrades.

## Audit result and runtime limit

Fresh `pnpm audit --json` results, using the same advisory service:

| State | Critical | High | Moderate | Low |
| --- | ---: | ---: | ---: | ---: |
| Baseline | 5 | 29 | 11 | 1 |
| Approved leaf upgrades | 2 | 29 | 10 | 1 |

No new advisory appeared. Besides the three critical advisories above, the
standalone Handlebars upgrade removes moderate
[GHSA-xw65-4hp5-5hc7](https://github.com/advisories/GHSA-xw65-4hp5-5hc7).
The audit still fails. The CI audit command currently catches that failure with
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

## Approval groups for the remaining published fixes

Versions and parent ranges were checked against registry metadata and the
baseline lockfile. They establish candidate compatibility, not a successful
installation or test result. No proposed upgrade has been installed or applied.
If a resolver needs another package/version beyond a group below, stop and
return that additional change for approval.

| Group | Exact proposed changes | Remaining findings targeted | Required validation |
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

The authoritative target list is the existing lockfile's 3.28.0 family; verify
the enumeration against that lockfile before applying group D.

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

## Findings requiring a separate implementation decision

No published patched version exists for
[`node-forge <=1.4.0`](https://github.com/advisories/GHSA-86w9-cpqp-85rv) or
[`braces <=3.0.3`](https://github.com/advisories/GHSA-vfj7-8cjw-p6xm), one high
advisory each. Current latest owner metadata still reaches the same vulnerable
packages. A blind Nuxt/Nitro upgrade is not an established fix.

- `node-forge`: a reviewed, pinned backport of the still-unmerged
  [upstream RSA verification fix](https://github.com/digitalbazaar/forge/pull/1158)
  at head `f192c67ee5850e44296ef83d6a7b6df6552ba8bf` is a candidate mitigation.
  It needs locally verified forged/valid-signature tests
  and separate approval; it would leave the published 1.4.0 audit finding open.
  For actual package removal, Nuxt CLI → listhen's certificate generation,
  CA signing, encrypted keys and PFX parsing all need compatible replacements.
  Merely substituting `selfsigned 5.5.0` would not preserve those interfaces.
  Native Node TLS can consume PFX, but changing the returned HTTPS configuration
  needs caller/type review and key, SAN, expiry, PFX and real HTTPS tests.
  No complete replacement or production attacker-controlled signature path
  was established. No new certificate dependency is proposed for approval yet.
- `braces`: Nitro → globby → fast-glob → micromatch uses its pattern parser.
  Replacing globby with the already locked `tinyglobby 0.2.17` is a candidate
  owner change. Inspection of all nine core/Rollup/Cloudflare calls found
  supported `cwd`, `absolute`, `dot` and `ignore` options, but configurable
  positive/negative patterns need differential tests for exclusion/re-inclusion,
  ordering, escaped paths, directories, symlinks, errors and Windows behavior.
  Approval would cover replacing Nitro's actual dependency edge while preserving
  its existing patch; every remaining braces owner must disappear before claiming
  removal. No attacker-controlled production glob path was established.
- Embedded Handlebars: request approval to rebuild the pinned Actual API 26.10.0
  source with official Handlebars 4.7.10 and retain its reproducible bundle delta
  in the existing API patch, preserving the grouped-query fix. Prove red/green
  behavior against the embedded implementation, ordinary template/rule behavior,
  grouped-query behavior and corrected installed/production bytes. Exact build
  reproducibility is unverified; stop if unrelated bundle changes cannot be
  explained. A standalone override or version-string edit cannot meet this goal.

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
| node-forge | 0 | 1 | No published patch; owner decision required |
| braces | 0 | 1 | No published patch; owner decision required |

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
