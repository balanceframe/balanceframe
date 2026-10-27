# Optional local receipt OCR

BalanceFrame works with manual receipt entry and photo capture without an OCR
service. OCR is a separate Docker image and Compose profile. Core installation,
builds, startup and health do not install, download, compile or wait for OCR.

The recommended optional deployment runs Tesseract 5.5.3, Leptonica 1.87.0 and
English tessdata_fast 4.1.0 on a private internal network. Images and extracted
text stay on your host. The sidecar has no published port, external network,
application credentials, persistent volume or access to Actual Budget.

## Enable it explicitly

Complete the ordinary [Docker setup](../README.md#quick-start-docker) first.
From the repository root, explicitly select the overlay and profile:

```sh
docker compose -f compose.yaml -f compose.ocr.yaml --profile receipt-ocr up -d --build
```

If using the bundled Actual server, include `-f compose.actual.yaml` as well.
The overlay preserves BalanceFrame's existing default network for reaching
Actual and adds the private OCR network. It sets
`BALANCEFRAME_RECEIPT_OCR_URL=http://receipt-ocr:8088` on BalanceFrame. There is
no `depends_on` or core health dependency. Manual entry remains available when
OCR is absent, busy, unavailable, times out, or produces uncertain text.

The first optional image build needs network access to Debian packages and the
checksum-pinned upstream sources below. It can take several minutes and adds
CPU/storage overhead. The image includes the English model; runtime never
fetches engines, models or cloud OCR. Normal `pnpm install` adds no OCR runtime. Workspace `build` and the core
Dockerfile only check this package's JavaScript syntax.

To disable OCR, recreate BalanceFrame using the ordinary manifest and stop the
optional service:

```sh
docker compose -f compose.yaml -f compose.ocr.yaml --profile receipt-ocr stop receipt-ocr
docker compose -f compose.yaml up -d --force-recreate balanceframe
```

Use the same explicitly selected files and profile for later optional upgrades.
Do not publish the sidecar port or attach it to an externally reachable network.

## Boundaries and review

The authenticated BalanceFrame photo route calls `POST /v1/extract` with a raw
JPEG or PNG body and the exact `image/jpeg` or `image/png` Content-Type. The
sidecar checks image magic and allows at most 5 MiB and one active upload or
extraction. PDF, SVG, other languages and arbitrary Tesseract arguments are not
supported. The fixed English engine receives a private directory (0700) and
image file (0600); files are deleted after success, failure or cancellation.

JSON responses are also bounded to 1 MiB, including escaped text. Each child
process is killed after 10 seconds, after more than 1 MiB stdout,
or after excessive diagnostics. Receipt bytes, text, filenames and subprocess
diagnostics are never logged by the sidecar. Docker bounds it to one CPU,
512 MiB memory, 32 PIDs and a 32 MiB temporary filesystem. It runs without root,
writable root filesystem, capabilities or privilege escalation. Image decoding
can still exhaust that container's resources; core health and manual entry are
independent of its availability.

Successful JSON contains `engine: "tesseract"`, `engineVersion: "5.5.3"`,
`modelVersion: "4.1.0"`, `text`, and the SHA-256 `contentHash` of the original
image bytes. Empty or imperfect text remains uncertain. Inspect and correct
receipt facts in BalanceFrame before saving or approving financial actions.
OCR does not authorize a transaction or infer an income category.

Errors contain only an error code: unsupported images (415), oversized images
(413), concurrent work (429), invalid/failed extraction (422), timeout (504),
or unavailable engine (503). `GET /health` reports this service alone. Startup
refuses an engine/library/model version or model checksum mismatch and leaves
BalanceFrame unaffected. The core caller also checks pinned versions and the
raw image hash before using a response.

## Sources, checksums and licenses

The optional [Dockerfile](../packages/receipt-ocr/Dockerfile) verifies SHA-256
before compiling or installing these HTTPS inputs:

| Component                               | Source                                                                                       | SHA-256                                                            |
| --------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ |
| Tesseract 5.5.3, Apache-2.0             | [tag archive](https://codeload.github.com/tesseract-ocr/tesseract/tar.gz/refs/tags/5.5.3)    | `9218e62793116d42a9f6d14cd9348518b27f382096eea3d0f2d1a24616bb5884` |
| Leptonica 1.87.0, BSD-2-Clause          | [tag archive](https://codeload.github.com/DanBloomberg/leptonica/tar.gz/refs/tags/1.87.0)    | `fa2b40c5caea96d1bb93a97486262aed8731b69ce25a84a6bf5d25323e33f631` |
| English tessdata_fast 4.1.0, Apache-2.0 | [model](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/eng.traineddata) | `7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2` |

The model's [license](https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/4.1.0/LICENSE)
is also checksum pinned. Full upstream licenses are included in the image under
`/opt/ocr/licenses`; [attribution](../packages/receipt-ocr/THIRD_PARTY_OCR.txt)
lists all three components. Debian/Node/JPEG/PNG/zlib distribution notices
remain in the base image. There are no npm runtime dependencies.

## Local verification

```sh
pnpm --filter @balanceframe/receipt-ocr build
pnpm --filter @balanceframe/receipt-ocr coverage
tests/deployment/compose-validate.sh
```

The package tests use clearly synthetic executable stubs to exercise timeouts,
size limits, cancellation and version refusal. Offline Compose tests prove
that the default manifest does not enable OCR and that the explicit overlay
isolates it. These tests do not establish OCR recognition quality. Build and
run the optional image against a synthetic receipt to verify the real engine;
never substitute a different installed Tesseract version for that check.

## Verification recorded for this implementation

On 2026-10-21, workspace-only builds from the checksum-verified archives above
reported `tesseract 5.5.3`, `leptonica-1.87.0`, and the checksum-verified English
model 4.1.0. No system OCR installation was changed. Through the real HTTP
handler and child-process helper, a synthetic PNG returned HTTP 200 and exactly:

```text
SYNTHETIC SHOP
2026-10-21
TOTAL 12.34
```

The raw PNG SHA-256 was
`72bd99812d91c4253b070ca46a9050805eb5f51fa8a4dadd570e6e51e8292bcd`;
the response matched it and the extraction directory contained zero remaining
files. The local process and HTTP server were stopped. This verifies the pinned
engine and integration contract for synthetic input, not general receipt accuracy.
The package's 16 deterministic tests passed, with 92.50% line coverage, 90.44%
statement coverage and 95.34% branch coverage. Syntax-only package builds passed.

The optional container image was **not verified** in this execution environment.
Docker Engine 28.4.0 / Buildx 0.31.0 could fetch the Node base image, but both
ordinary and `--network=host` builds failed during `apt-get update`: temporary
DNS failure resolving `deb.debian.org`, followed by package installation exit 100. The failure preceded OCR compilation inside the image. A successful local
engine build does not establish that the complete image works; operators should
complete that image build and synthetic check where container DNS is available.

The OCR-specific offline Compose tests passed under Compose 2.40.3. The existing
research-overlay validator separately fails because that renderer emits
`bind: {}` for explicit `create_host_path: false`, while the validator requires
an explicit JSON `false`. A private diagnostic confirmed the exact read-only
bind source and no created directory; a temporary `true` variant rendered an
explicit JSON `true`. No research manifest or validator was changed here.

### Container qualification recheck, 2026-10-27

At source commit `6fe0c2d4075d841bdc45d9d12ecda2e7a24df265`, Docker Engine
28.4.0, Buildx 0.31.0 and Compose 2.40.3 were available, but no existing OCR
image was present. The unchanged optional Dockerfile SHA-256 was
`a77a666d5a1ac4c64aee41c332c84cdc72f2705dfcf8a1e4482d512348b0fa89`.
All approved engine, library, model and source checksums above remain unchanged.

The pinned build was attempted with a private writable Docker client
configuration because the environment's home directory is read-only:

```sh
(
set -e
ocr_docker_config=$(mktemp -d)
trap 'rm -rf -- "$ocr_docker_config"' EXIT
DOCKER_CONFIG="$ocr_docker_config" docker build --progress=plain \
  -t balanceframe-ocr-qualification:20261027 \
  -f packages/receipt-ocr/Dockerfile .
)
```

The Node base image resolved to
`sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205`.
The runtime package layer reported `Temporary failure resolving
'deb.debian.org'`, could not locate `libpng16-16` or `libjpeg62-turbo`, and
exited 100. The parallel compiler-package layer was canceled. No OCR source
compiled, no OCR image was produced and no container was started. The recheck
used the default build network and changed no host permissions, dependency
versions, network policy or runtime security controls.

Supporting checks passed on Node 24.19.0 using the existing Vitest 4.1.11
installation:

- Syntax checks passed for all three sidecar modules.
- Both OCR test files passed all 16 tests, including synthetic subprocess
  timeout, abort, output bounds, private-file cleanup, pinned-version refusal,
  source hash and HTTP error behavior. Coverage was 92.50% lines, 90.44%
  statements, 96.51% branches and 90.90% functions.
- The web tests `test/server/receipt-ocr.test.ts`,
  `test/pages/receipt-photo-capture.test.ts` and
  `test/pages/receipt-photo-client.test.ts` passed all 40 tests. They cover
  unconfigured/offline/timed-out OCR fallback, source/version validation and
  manual photo review with synthetic responses. Reproduce after normal workspace
  dependency setup and Nuxt preparation with
  `pnpm --filter @balanceframe/web exec vitest run test/server/receipt-ocr.test.ts test/pages/receipt-photo-capture.test.ts test/pages/receipt-photo-client.test.ts`.
- `tests/deployment/compose-validate.sh` passed, including the research bind
  policy checks that failed during the earlier verification. The OCR deployment
  tests separately passed default-off and explicit-profile isolation assertions
  without starting services.

These checks establish deterministic boundary and component behavior only.
Real container HTTP extraction, runtime versions, original-image hash,
temporary-file cleanup and timeout behavior remain **unverified** until the
unchanged image builds with ordinary container DNS. No live browser flow or
recognition-quality claim is made by this recheck. All task-owned test processes
completed; no qualification container or service remains running.
