# Residual dependency-security disposition — 2026-10-27

Status: assessment complete; package remediation awaits exact-scope approval.
No dependency, override, patch, security default or audit gate changes are included.

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

## Remaining findings

Each link identifies the advisory returned by the audit. Versions in the last
column are published fixed floors, not approved or installed changes.

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

## Smallest remediation proposal

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
