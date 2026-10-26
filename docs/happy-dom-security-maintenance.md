# Happy DOM security maintenance — 2026-10-26

The approved development-only upgrade changes web Happy DOM `20.11.1` to
`21.0.4`. The lockfile changes only its version, range, integrity and the
resulting Vitest peer references. Other package resolutions, dependency edges,
patches and lifecycle permissions remain identical. No application or Vitest
configuration changes are needed.

Upstream [21.0.4](https://github.com/capricorn86/happy-dom/releases/tag/v21.0.4)
fixes invalid import-binding code injection
([GHSA-834v-8h66-3h79](https://github.com/capricorn86/happy-dom/security/advisories/GHSA-834v-8h66-3h79))
and opaque-origin iframe isolation. The
[21.0.0 default change](https://github.com/capricorn86/happy-dom/releases/tag/v21.0.0)
disables external CSS and iframe loading to address
[GHSA-c8p4-j97h-3vg8](https://github.com/capricorn86/happy-dom/security/advisories/GHSA-c8p4-j97h-3vg8).
These safer defaults are preserved. No global JavaScript or resource-loading
opt-in is introduced.

## Regression evidence

`pnpm test:dependency-security` includes six Happy DOM gates. Synthetic module
sources use inline JSON data and only assign an in-memory marker. Network
checks use an owned loopback HTTP server with bounded responses. Each scenario
runs in a child with a 128 MiB heap limit, 10-second timeout and 64 KiB output
limit. Every browser and server is closed in cleanup. Only the module fixtures
enable JavaScript; only the iframe isolation fixtures enable iframe loading.

On `20.11.1`, the invalid alias executes the marker assignment, default parsing
requests both `/style.css` and `/frame`, and a loaded `data:` child can read its
parent document. All three security regressions fail. Ordinary JSON module
imports and inherited-origin `about:blank` iframe access pass on both releases.
On `21.0.4`, all six gates pass, including exact version resolution.

One upstream diagnostic limitation remains: denied parent/top location reads
from a `data:` child recurse while formatting the error and throw `RangeError`.
The tests record that exact behavior; they also require that parent/top
documents are unavailable and that the iframe's `contentWindow.location`
throws `SecurityError`. This is not a claim that Happy DOM is a secure sandbox
for arbitrary code. No first-party external CSS or iframe test dependency was
found, and no upstream patch or broader dependency change is included.

Raw command logs, baseline failures, corrected final-fixture baseline failures,
target successes and the exact lockfile scope proof are retained under
`/workspace/.setup/happy-dom-21-evidence/`. The first Nuxt typecheck ran before
workspace build outputs existed and failed on missing workspace declarations;
that diagnostic is retained separately from final verification.

## Final verification

Node `24.19.0` and pnpm `10.24.0` were used with the existing pnpm store.

| Check | Result | Evidence log |
| --- | --- | --- |
| Final fixtures against `20.11.1` | Three security failures; both compatibility controls pass | `red-final-fixtures.log` |
| Happy DOM regression gates | 6 passed | `green.log` |
| All dependency security gates | 93 passed | `dependency-security.log` |
| Frozen offline install | Passed | `frozen-install.log` |
| Exact lock scope and installed package/tarball integrity | Passed | `lock-scope.log`, `installed-package-bytes.log` |
| Root lint and typecheck | Passed | `lint.log`, `root-typecheck.log` |
| Full workspace build, including native and Nuxt | Passed | `build.log` |
| Full web suite | 160 files, 2,362 tests passed | `web-tests.log` |
| Nuxt typecheck after build | Passed | `web-typecheck.log` |
| Existing production Zod isolation gates | 3 passed | `production-zod.log` |
| Production Happy DOM package paths and server bare imports | None found | `production-happy-dom-absence.log` |

The production output's root manifest has no Happy DOM dependency. Copied
Better Auth and utility manifests retain their original Happy DOM entries only
under `devDependencies`; their runtime dependency fields do not declare it.
Those retained development metadata entries are recorded in
`production-happy-dom-manifest-grep.log` rather than removed or concealed.

Independent lead correctness and complexity review accepted the five-file
change and separately reran the six regressions and exact lock scope check.
No live browser flow, coverage run, full workspace test aggregate or container
deployment is claimed for this development dependency slice. No publication,
push, pull request or merge is included.
