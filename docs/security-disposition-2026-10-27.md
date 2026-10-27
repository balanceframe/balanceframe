# Residual dependency-security disposition — 2026-10-27

Status: the owner-approved updates are implemented; independent review and CI
remain required. The approved closure and local verification are recorded below.
Security defaults, patch contents and audit gates are preserved.

## Source and reproducibility

Assessed main `6fe0c2d4075d841bdc45d9d12ecda2e7a24df265`, tree
`9f4a0e610be1ef7ef6d92e507d5d283f15a525ce`, after PRs #45–#48 merged.
The dated sections in `dependency-security-maintenance.md` retain their historical
meaning: Happy DOM and the coordinated Zod 4 migration are now delivered.

Run `pnpm audit --json` against the frozen lockfile. On this date it exited 1
with **18 advisories: 0 critical, 1 high, 12 moderate, 5 low**. Audit metadata
reported 1,050 dependencies and did not reliably distinguish development scope;
reachability below comes from dependency paths and source, not that metadata.
The current dependency-security suite passed **157 tests**, zero failed/skipped.
These tests are focused mitigation evidence, not proof that all advisories are
unreachable or a clean security audit. Registry results can change after this date.

## Findings at the assessment baseline

Each link identifies the advisory returned by the baseline audit. Versions in the
last column were proposed fixed floors; the resulting installed closure follows.

| Package and locked version | Advisories / severity | Observed owner and boundary | Fixed floor / decision |
| --- | --- | --- | --- |
| `node-forge` 1.4.0 | [nested DigestAlgorithm](https://github.com/advisories/GHSA-86w9-cpqp-85rv), high | Nuxt CLI → listhen certificate tooling; existing RSA source patch and real signature/parser controls retained | No published fixed version; retain reviewed mitigation, do not remove patch merely to change audit output |
| `nuxt`, `@nuxt/nitro-server` 4.5.2 | [route-rule case variants](https://github.com/advisories/GHSA-vjh5-4x84-xrqp), two moderate entries; [server-island head sanitization](https://github.com/advisories/GHSA-xfq5-w38q-pc2x), moderate; [NuxtLink control-prefix URL](https://github.com/advisories/GHSA-jjm6-p2m9-9w4x), low | Framework/runtime owner. Current config has `ssr: false`, no explicit `routeRules` or server islands; pages are enabled. These observations narrow known paths, not a universal non-reachability proof | Coordinated Nuxt 4.6.2 family; preserve native Actual/SQLite boundaries and all compatible security patches |
| `@vitest/mocker` 4.1.11 | [mock registration injection](https://github.com/advisories/GHSA-qxg6-89mg-rqv8), [Windows redirect traversal](https://github.com/advisories/GHSA-xp26-3454-mjgp), both moderate | Test/browser development server; not evidence of a production HTTP route | Vitest 4.1.12 with its matching `@vitest/*` family, not a lone mismatched mocker override |
| `postcss` 8.5.19 | [sourceMappingURL read](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp), moderate | Nuxt UI → Tailwind PostCSS build transform | 8.5.23 |
| `postcss-selector-parser` 7.1.4 | [flat selector CPU exhaustion](https://github.com/advisories/GHSA-rj75-hqrm-r3gf), moderate | Nuxt Vite builder → cssnano/PostCSS build transform | 7.1.6 |
| `baseline-browser-mapping` 2.10.44 | [invalid-input process exit](https://github.com/advisories/GHSA-w5vr-8v7q-w6rv), moderate | Nuxt/Babel → Browserslist build targets | 2.11.0 |
| `fast-uri` 3.1.7 | [host normalization](https://github.com/advisories/GHSA-hrr3-gc8f-f4qj), [scheme spoofing](https://github.com/advisories/GHSA-w74x-v6f9-j3xg), [host confusion](https://github.com/advisories/GHSA-wjr9-j795-jxcr), moderate; [path equivalence](https://github.com/advisories/GHSA-xhq7-xmqj-769h), [suffix scheme injection](https://github.com/advisories/GHSA-333x-w4r6-6crp), low | Contract-test AJV URI/reference handling; keep canonical schema fixtures and local-only reference registry | 3.1.9 covers all five |
| `brace-expansion` 5.0.11 | [quadratic rewrite](https://github.com/advisories/GHSA-q2hr-2g5m-vwhr), moderate | TypeScript ESLint parser → minimatch; distinct from already-patched `braces` | 5.0.12 |
| `serialize-javascript` 7.0.7 | [function-end script escape](https://github.com/advisories/GHSA-m5mm-p8h7-m29v), low | Nitro → Rollup terser plugin build serialization | 7.1.3 |
| `esbuild` 0.27.7 | [Windows dev-server file read](https://github.com/advisories/GHSA-g7r4-m6w7-qqqr), low | Nuxt UI → fonts → fontless 0.2.1. Fonts are disabled in project config; other consumers already use esbuild 0.28.1 | 0.28.1 is outside fontless's `^0.27.0` range; do not impose it globally without compatibility review |

## Proposal recorded before owner approval

1. Approve compatible leaf updates to PostCSS 8.5.23, selector parser 7.1.6,
   browser mapping 2.11.0, fast-uri 3.1.9, brace-expansion 5.0.12 and
   serialize-javascript 7.1.3. Inspect owner ranges and the exact lockfile diff;
   do not use a broad unconstrained update.
2. Approve Nuxt 4.5.2 → 4.6.2 and Vitest 4.1.11 → 4.1.12 with their required
   coordinated package families. Nuxt registry metadata pins kit/schema/nitro-server/
   vite-server/vite-builder to 4.6.2; Vitest pins its own sibling packages to
   4.1.12. Recheck Nitro/DevTools patch applicability rather than discarding patches.
3. Evaluate fontless's esbuild owner separately. Prefer an owner-supported fixed
   range if available; otherwise bring an explicit targeted override/removal
   proposal back for approval. Do not enable fonts or expose a development server.
4. Keep Forge's approved nested-count/NULL mitigation and Braces protections.
   The Forge advisory has no published fixed release; its version flag remains.

The alternative is to retain current versions with documented exposure and
mitigation. That avoids compatibility changes but leaves the listed unpatched
advisories. Recommended: the bounded compatible updates and coordinated framework/
runner updates above, followed by the separate esbuild decision. No major migration
is proposed; a same-major framework update still needs production validation.

## Required verification after approval

Use failing-before security probes and ordinary controls for changed packages;
frozen install; complete web/CLI and schema/AJV/Rust contract consumers; full
workspace coverage without lowered thresholds; production Nuxt build and actual
artifact Zod/Actual/SQLite binding checks; portable Windows/Linux/macOS CI; and
permitted authenticated disposable browser smoke checks. Preserve all existing
patch tests. Compare a fresh full audit with this dated baseline; remaining flags
must stay disclosed, and a green nonblocking CI audit does not close them.

## Approved updates and resulting dependency closure

The owner approved the exact listed updates and the required coordinated Nuxt
4.6.2 / Vitest 4.1.12 dependency families. The lockfile uses those releases.
Existing Nitro 2.13.4 and DevTools 3.4.3 are constrained explicitly because Nuxt's
compatible ranges otherwise select newer releases and orphan the approved patches.
The unchanged Forge, Braces, Actual SDK, Nitro and DevTools patches all remain
registered and applied. Neither fontless 0.2.1 nor esbuild 0.27.7 / 0.28.1 changes.

The vulnerable Tailwind PostCSS edge is constrained to 8.5.23. Nuxt's new Vite
builder independently requires PostCSS `^8.5.30`; its resolved 8.5.32 is part of
that required closure. Baseline-browser-mapping 2.11.0 is scoped to Browserslist
4.28.7, whose `^2.10.44` range accepts it. Required cssnano 9 needs Browserslist
`^4.29.3`; its resolved 4.29.5 requires mapping `^2.11.33` and resolves 2.11.33.
The initial global 2.11.0 override violated that range. A failing-before regression
now checks actual installed/locked dependency edges against every matching owner
range for all new override targets, including the PostCSS edges. It was corrected
without a compatibility waiver. Fast-uri 3.1.9,
brace-expansion 5.0.12 and serialize-javascript 7.1.3 use exact resolution
constraints. The new builder requires cssnano `^9.8.0` and resolves 9.9.0, whose
dependency graph removes postcss-selector-parser and the postcss-svgo/SVGO chain.
Consequently there is no installed selector-parser 7.1.6: the affected owner is
gone. An unused package was not added just to retain a version or test fixture.
The existing SVG assertions remain intact when their owner exists; the replacement
graph must prove both removed packages absent. The current optimizer also has an
ordinary CSS transformation control.

The inherited Nitro → archiver 8 override retains its previously approved API
backport; upstream Nitro metadata still declares archiver `^7.0.1`. That existing
exception and patch are unchanged. The new owner-range regression covers this
change's new constraints and matching consumers, rather than claiming that the
entire historical lockfile has no approved compatibility backports.

The required Nuxt closure introduces these package names into the lockfile:

| New package | Version | Required owner |
| --- | --- | --- |
| `@csstools/css-tokenizer` | 4.0.2 | cssnano / postcss-calc |
| `@nuxt/vite-server` | 4.6.2 | Nuxt |
| `args-tokenizer` | 0.3.0 | Nuxt CLI |
| `clickable-path` | 0.1.1 | Nuxt, CLI, Vite builder/server, my-bad |
| `fetchdts` | 0.2.0 | Nuxt |
| `flru` | 1.0.2 | Nuxt Nitro server |
| `fuzzysort` | 4.0.2 | Nuxt CLI |
| `microdiff` | 1.6.0 | Nuxt kit |
| `my-bad` | 0.2.11 | Nuxt and its CLI/Nitro/Vite packages |
| `uint8array-extras` | 1.6.0 | iron-webcrypto 2 |

Required transitive major transitions or additional major lines are:
`@nuxt/cli` 3.37.0 → 4.0.1; `cssnano` 8.0.2 → 9.9.0;
`postcss-calc` 10.1.1 → 11.2.3; `@colordx/core` 5.5.0 → 7.3.0;
`devalue` 5.9.4 → 6.0.3; `srvx` 0.11.22 → 1.0.5/1.0.8;
plus `ast-kit` 3.0.0, `iron-webcrypto` 2.0.0, `obug` 3.0.0, `tinyclip` 1.0.3
and `unimport` 7.0.2 alongside their retained older consumers. These are upstream
dependencies of the approved release, not new application capabilities or
top-level packages. Nuxt now owns Forge through Nitro → listhen; its security
test resolves that real owner rather than relying on the old CLI's hoisted lookup.

## Remediation verification and remaining limits

On Node 24.19.0 / pnpm 10.24.0, frozen installation passes. Thirteen new security
probes cover annotated map disclosure, selector-parser work/removal, browser
mapping process exit, all five URI defects, brace parser rewrites, script-safe
serialization, both mocker defects and a disposable Nuxt production server.
All 13 probes fail against the original dependency graph and pass after the
update. The `BALANCEFRAME_RESIDUAL_TEST_ROOT` test hook can point at an untouched
baseline installation without downgrading or editing the current dependencies.
In particular, that baseline
server returned 307 for `/protected/secret` but 200 for `/Protected/secret`, and
emitted a C0-prefixed `javascript:` anchor. The updated server applies the redirect
to both paths and rejects the unsafe link while preserving an ordinary link.
The server-island advisory is removed from the audit by the approved release;
its exploit path was not separately exercised.

The full dependency-security suite passes **171/171**, with no skips. The main
production Nuxt build passes; all three compiled Zod artifact checks pass. The
traced Actual SDK matches the installed patched bundle byte-for-byte, SHA-256
`1191509c5c629d99bdf6d4d96637c66abb3fe6e11da2428b4cec30d154ea58c7`, and all 13
embedded SDK security tests pass against the artifact. Production SQLite's native
binding passes a synthetic in-memory write/read. The native N-API suite and
**962 Rust workspace tests** pass. Root lint, root typecheck and web vue-tsc pass.
Thirty deployment contracts and the offline Compose validator pass.

After the owner-range correction, complete coverage runs pass for web
**2,369/2,369**, CLI **203/203**, protocol validators **241/241**, and native-backed
schema/AJV contracts **193/193**, with no skipped/pending tests. Their line
coverage is respectively **85.70%, 89.53%, 96.97%, and 100%**. CLI entrypoint and
coverage-runner behavior checks also pass. The earlier broader JavaScript
coverage attempt was interrupted when the incompatible mapping override was
identified; its prefix logs/reports are supporting evidence only, not a final
aggregate pass.

A final-graph live Actual aggregate stopped at **84 passed / 1 failed** when the
existing server returned HTTP 429 during export/restore authentication. That
intentional rate safeguard was preserved. Running every unchanged Actual test
file against its own freshly seeded canonical fixture passes **133/133 across
all 13 files**, including export/restore. These partitioned reports establish
the complete test cases, not a passing single-run aggregate coverage gate.
Every owned fixture listener was checked closed before its data was removed;
the generated fixture environment file was cleaned up.

The refreshed audit still exits 1, now with **2 advisories: 1 high, 1 low** and
1,046 reported dependencies. They are Forge 1.4.0 with the retained mitigation
and fontless's deferred esbuild 0.27.7. There are zero critical/moderate findings;
this is not a clean audit or a claim of universal non-reachability.

The combined Rust/native/workspace coverage runner exits before execution because
this environment lacks `llvm-cov`, `llvm-profdata`, `cargo-llvm-cov` and `gdb`;
Nix is also unavailable. Its scripts, thresholds and registration-failure probe
are unchanged. Complete coverage-gate and portable CI results remain pending.
Component/API checks and the disposable Nuxt security fixture do not replace an
authenticated browser acceptance run against the updated application.
