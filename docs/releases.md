# Release Policy

## Unreleased v0.9.0 — Transaction evidence and intelligent resolution

Stable acceptance is still in progress; this is not a completed stable release.
See the [current acceptance checklist](roadmap/post-mvp/11-5-implementation-status.md)
and the [acceptance-testing beta policy](#acceptance-testing-betas).

- Immutable scoped evidence, encrypted raw retention/deletion, camera/photo and
  manual photo/PDF receipt entry, with optional local OCR isolated in a default-off Compose
  profile. Core installation, startup and manual review never require extraction.
- Rust financial conservation, receipt/return lineage, explicit many-to-many item
  allocations across existing Actual settlements, inspectable native manifests,
  and the ordinary governed credit/amendment pipeline with reread/recovery proof.
- Exact human-attested wallet statement intervals and activity; governed nonzero
  opening equity, distinct from income/refunds, with independent approval and
  Actual starting-balance/account-balance verification.
- Explicit receipt versions, return/fulfillment/member review, saved-session
  comparison, contextual deterministic categorization and approved rule learning.
- Receipt-item inference has a distinct typed subject, minimized label/category-alias
  preview, independent local/external permissions and three policy opt-ins, durable
  consent/quota/cache/audit, and asynchronous source/authority revalidation. Rules
  run first; manual entry remains available. Production providers are unconfigured.
- Email forwarding is deferred by user direction. Authenticated browser validation
  and optional OCR-container verification remain open. Automated release gates
  must pass for each tagged release. No live financial changes or account
  connections are authorized by a beta release.

## Unreleased — fixes

- Native Windows now rejects the exported `EncryptedCredentialStore` before
  filesystem access. Existing files are preserved, with no automatic migration
  or fallback. Explicit `EnvCredentialStore` and Linux/Docker persistence remain
  supported; the application's default credential path already uses the
  environment store. See [ADR 0007](adr/0007-windows-file-credential-store-boundary.md).

## Unreleased — Phase 9 controlled consequential actions

- Exact reallocation proposals reuse ordinary selected-space authorization, immutable native planning, distinct-human approval, durable acquisition, Actual write/readback and native postcondition verification. Space assistance is a maximum; absent legacy configuration disables the new action workflow without changing existing categorization or rule permissions.
- The shared action contract covers manual/split debits, source-resolved ledger projections, zero-opening-balance wallet accounts, ledger-only transfers and ordered composites. Native amounts, availability, assignment deltas and intermediate dispatch states are separate; a transfer record does not establish institution settlement.
- Budget-wide acquired ownership excludes competing local mutations across workflow connections; stable economic identities prevent duplicate projections. Uncertain or interrupted writes retain ownership for native-proven read-only recovery, not automatic retry, rollback or lease takeover. Lost generated wallet identity requires review.
- Proposal review offers **Check prior execution** for uncertain outcomes. The original executor can request read-only reconciliation after the execution window expires; current read authority and exact native postconditions still apply. **Refresh** reloads recorded status, and unresolved checks retain the financial hold without dispatching another write.
- Existing workflow databases receive an append-only completion-intent fence migration. Back up the workflow database before upgrade; historical uncertain intents remain held and are not silently reauthorized.
- Operators must ensure exclusive mutation ownership of the selected Actual budget during execution. The SDK has no compare-and-set; another Actual editor or deployment using a separate workflow database can race outside BalanceFrame's fence. Matching final readback is not proof that no intervening external edit was overwritten.
- Purchase Check, Spend Sessions, scoped proposal review and the CLI expose exact envelope/cash tradeoffs and separate approval/execution controls. Private source hashes, supplemental records and execution proofs are withheld. See [Phase 9](roadmap/post-mvp/09-controlled-reallocations.md) and [ADR 0003](adr/0003-space-governance-and-exact-authority.md) for acceptance evidence and operating limits.

## Unreleased — Phase 11 merchant intelligence

- Local Rust analysis adds scoped merchant/category evidence, conservative recurrence/calendar reasoning and human alias, correction and pattern intent. Review, Dashboard and authenticated CLI share current source and authorization checks. Native Actual rule proposals retain complete simulation/provenance and execute independently of BalanceFrame; enrichment never supplies financial permission.
- Existing workflow databases use the store's transactional schema migration. Missing merchant policy remains local-only; old proposals or cached conclusions are not silently promoted into current evidence. Back up the workflow database before upgrade. Restore invalidates derived cache/decision reuse and retains outstanding billing holds; lifecycle deletion purges derived content without deleting Actual transactions, native rules or historical governance attribution.
- Optional ValueSerp research is **off by default**, absent from Sync, and requires installation, space and budget opt-in plus exact research grants and preview consent. `BALANCEFRAME_MERCHANT_CONFIG_PATH` names the bounded server-owned deployment JSON validated by [`merchant-settings.ts`](../packages/application/src/merchant-settings.ts); `VALUESERP_API_KEY` is a server-only secret, not a JSON/browser/Actual field. The JSON supplies versioned installation policy, credential identity/limits and account-confirmed tariff. Missing/invalid configuration or pricing refuses dispatch while local review remains usable. Use a dedicated key; scrub query-bearing provider URLs from deployment proxies, access logs and traces before enabling research.
- Deployment assets now reuse the current canonical templates and include the opt-in `compose.research.yaml` with SHA-256 checksums. Bundled Actual uses a managed shared network; the standalone manifest retains its external network. Offline semantic checks do not prove account pricing, live billing, or deployed proxy/APM redaction; those remain explicit operator prerequisites before enabling research.
- User export/delete and policy changes require current scoped authority and fresh human authentication. External request/attempt metadata, cache TTL and deletion fences follow the [Phase 11 retention contract](roadmap/post-mvp/11-merchant-intelligence-and-enrichment.md#5-retention-and-deletion-defaults); disable is not upstream erasure. No public-page scraping or automatic remote fallback is installed.
- Review/projection retention uses original server-captured expiry/age and derivation ownership, not reviewer assignment or read time. Private actor cleanup preserves shared, other-actor and independently known other-namespace bundles, including nested legacy copies; only removal of authoritative inferred target evidence supersedes pending Review. Human intent, canonical Money and plain nested canonical `sourceRevision` are preserved. Retired research attempts retain only opaque replay fences and exact billing/lease data; merchant-derived fingerprints are scrubbed for both private and shared requests.
- Observed compiled disposable SQLite retention smoke retires an unassigned private-owner Review bundle, preserves peer/shared copies before original expiry and a foreign known legacy namespace, then retires remaining selected derived copies at inclusive original expiry. Exact Money and ordinary nested canonical revisions survive; no Actual ledger mutation is performed.
- Disposable scenario startup reserves both loopback ports together, preventing immediate ephemeral-port reuse from confusing Nuxt readiness with Actual initialization. The deterministic failure regression and original startup/purchase targets pass without retries.
- Local test/demo tooling now shares 40 independently loadable Actual-backed stories: the original 29 spending scenarios, three governance stories and eight merchant stories. Real human personas, invitation/rejoin, delegated metadata probes, independent native-rule approval, stale-source refusal and explicitly closed research consent/cache/quota/lifecycle paths use the normal application handlers. Historical anchors preserve validity durations at submission; short expiry stories remain short-lived. Run `pnpm scenarios verify --all` for named acceptance checks; the [scenario catalog](../README.md#disposable-feature-scenarios-and-demo) and [ADR verification evidence](adr/0002-owned-disposable-scenario-demo.md#expansion-verification) distinguish automated assertions from live browser observations.
- Payment preferences expose existing management eligibility and saved choices without requiring new approval proof on reads. Saved choices still require current owner, membership, policy and exact account/category authority; revoking account approval withholds the route. Writes require separate verified recent human-control proof: missing, expired or another-session proof cannot persist a preference. The editor requires and clears password/disposable confirmation; exact category/account, future expiry and optimistic version checks remain unchanged, with no Actual transaction edits.

Historical Phase 11 implementation verification (`99a7257`); current extension and follow-through receipts are recorded in the linked roadmap:

See the [Phase 11 quality, performance, coverage and runtime evidence](roadmap/post-mvp/11-merchant-intelligence-and-enrichment.md) for exact denominators, lossless native graphs and benchmark-window limits. Final addon SHA256 `3fea89730df48ec777ac3322cabcb83ae5f7f9aec621ac444b1144751cff15b4` passes all six synthetic quality gates and all eight size/workload native-window gates. Synthetic accuracy is not real-world accuracy; wide-OR 250k correlated response consumption is 5,299.8 ms, and exported kernel counters are not exact physical-memory measurements. All 854 Rust and 5,150 Vitest tests, unchanged coverage gates, production build, TypeScript, zero-warning ESLint, Rust/Nix formatting, all-target Clippy and authenticated alias acceptance pass. All 29 CLI scenarios, five native/service fault variants and four x86_64-linux Nix checks pass; aarch64-linux is not host-verified. External dispatch stays off until priced opt-in and deployment log redaction are verified; no live paid-provider acceptance is claimed. This documents unreleased capability, not a published package/image release.

## Versioning

BalanceFrame follows **Semantic Versioning 2.0.0** (`MAJOR.MINOR.PATCH`) for
all stable releases. Before `1.0.0`, `0.y.z` semantics apply:

- **PATCH (`z`)** — backward-compatible fixes for defects, performance, or
  documentation. No change to documented configuration keys, HTTP/API route
  contracts, persisted SQLite schema compatibility, or supported Actual Budget
  server compatibility.
- **MINOR (`y`)** — backward-compatible new capabilities, SQLite schema
  migrations, or optional configuration additions. Existing production
  deployments upgrade without configuration changes.
- **MAJOR (`x`)** — a breaking user-facing change: removed or renamed
  configuration keys, changed HTTP response contracts, altered SQLite schema
  format requiring explicit migration, or a dropped Actual server compatibility
  range.

  Before `1.0.0`, a **MINOR bump** (`0.1.0` → `0.2.0`) signals a breaking
  deployment/configuration/protocol change. PATCH (`0.1.0` → `0.1.1`) remains
  backward-compatible.

- **Pre-releases** use the suffix `-rc.N` or `-beta.N` (e.g. `v0.1.0-rc.1`).
  Pre-releases never advance `MAJOR`, `MAJOR.MINOR`, or `latest` tags on the
  image registry.

## Release channels

| Channel               | Tag pattern     | Image tag semantics                                                    |
| --------------------- | --------------- | ---------------------------------------------------------------------- |
| **Stable**            | `vX.Y.Z`        | Version tag `X.Y.Z`; mutable `X.Y`, `X` and `latest` advance            |
| **Release candidate** | `vX.Y.Z-rc.N`   | Version tag `X.Y.Z-rc.N` only; no convenience aliases                  |
| **Beta**              | `vX.Y.Z-beta.N` | Version tag `X.Y.Z-beta.N` only; no convenience aliases                |

Git tags include the `v` prefix; image tags do not. Pin an image digest for an
immutable installation reference.

## Acceptance-testing betas

An explicitly approved beta may be published to gather the outstanding browser
and container acceptance evidence listed in the release's checklist. Release
notes must identify unresolved acceptance checks and audit findings, directly or
through the linked release policy and checklist. Publishing a beta does not
record those checks as passed.

All automated release gates apply unchanged to beta tags.
Verification must pass before image publication; signing, provenance, SBOM and
release assets remain required. GitHub marks the published release as a
prerelease. Beta images never advance stable or rolling aliases.

An acceptance-testing beta does not complete the stable release or roadmap exit.
Stable publication still requires resolving the remaining acceptance criteria
and validation gates in the owning checklist.

For v0.9.0, the proposed first beta is `v0.9.0-beta.1`, producing
`ghcr.io/balanceframe/balanceframe:0.9.0-beta.1` only after successful publication.
Authenticated browser acceptance remains unverified. OCR is a separate,
default-off image/profile whose container build and runtime acceptance remain
unverified; the core release workflow does not publish that optional image.
Manual photo/PDF entry and core health must work without OCR. Receipt model
providers remain unconfigured.

The last full registry audit ([CI run 128, 2026-10-23](https://github.com/balanceframe/balanceframe/actions/runs/39945116352))
reported 2 high, 10 moderate and 2 low findings, including registry advisories
for locally patched `node-forge` and `braces`. This beta does not claim a clean
dependency audit. Browser acceptance is blocked by the Chromium sandbox; the
optional OCR image build is blocked by DNS resolution of `deb.debian.org`.

Use a separate installation, new disposable volumes and a fictional Actual
budget, with normal bootstrap, sign-in and explicit least-privilege grants.
Do not attach a beta to production data or reuse a live installation's volumes.
The production image excludes the source-only scenario/demo launcher and rejects
development authentication bypasses. The source
[walkthroughs](../README.md#transaction-evidence-walkthroughs-v090) describe the
five fictional evidence stories; their automated API checks do not replace
operating the UI in a real browser.

## Release process

1. Set root `package.json` to the base release version (e.g. `0.9.0` for
   `v0.9.0` or `v0.9.0-beta.1`). Complete the applicable stable or beta policy
   above before tagging the approved commit on main.
2. Create the approved annotated Git tag, for example:
   `git tag -a v0.9.0-beta.1 -m "v0.9.0-beta.1"`.
3. Push that tag: `git push origin v0.9.0-beta.1`.
4. The `release.yml` GitHub Actions workflow runs two sequential jobs with
   separate timeout budgets:
   - `verify` (45 minutes):
     - Nix flake checks
     - Workspace build, typecheck, lint, and tests
     - Rust workspace tests and clippy
     - Tag/version policy verification (`just release-verify`)
   - `publish` (an independent 60 minutes), which runs only after `verify`
     succeeds:
     - Multi-platform OCI image build and push to GHCR
     - SBOM, provenance, signature generation
     - Release asset generation from current templates (`just release-assets`):
       digest-pinned `compose.yaml`, `compose.actual.yaml`, opt-in
       `compose.research.yaml`, inert `.env.example`, and SHA-256 checksums
     - Published GitHub Release with all assets (`draft: false`); tags containing
       `-` are marked as prereleases

## OCI registry

The sole OCI registry is **GitHub Container Registry** under the repository
owner's namespace:

```
ghcr.io/<owner>/balanceframe@sha256:<digest>
```

Immutable digest references are the canonical image identifier. Human-readable
tags (`X.Y.Z`, `X.Y`, `X`, `latest`) are convenience aliases. Prereleases use
only their full version tag, such as `0.9.0-beta.1`.

## Configuration stability

- Documented configuration keys (environment variables and runtime config) are
  stable within a MINOR version. Adding a new key is a MINOR change; removing
  or renaming a documented key is a MAJOR change.
- **Development-only** configuration keys (`NUXT_DEV_BYPASS_AUTH`,
  `BALANCEFRAME_DEV_BYPASS_AUTH`, `NUXT_REVIEW_AND_APPLY`,
  `BALANCEFRAME_SEED_ALLOWED`) are intentionally absent from production
  images. The production entrypoint rejects any process that defines them.
- Actual connection credentials are managed through the application's
  connection/auth flow and are never exposed as compose-time environment
  variables.

## Account lifecycle (self-hosted registration)

BalanceFrame implements a two-state registration model designed for
self-hosted deployments that never share a public sign-up form.

### Bootstrap (first owner)

A fresh instance starts with no user accounts. The first (and only) owner
is created through a bootstrap flow protected by a high-entropy operator
secret:

- **Configure exactly one of:**

  `BALANCEFRAME_BOOTSTRAP_SECRET_FILE` — path to a file containing the
  secret (preferred for Docker Compose deployments; the project `compose.yaml`
  mounts `./.bootstrap_secret` to `/run/secrets/bootstrap_secret`).

  `BALANCEFRAME_BOOTSTRAP_SECRET` — inline environment variable (alternate
  mechanism; avoid when secrets management is available).

- Generate the secret with `openssl rand -hex 32` (produces a 64-character
  hex string). The resolved value must be at least 32 characters.
- The application fails closed at startup if both sources are set, the file
  is unreadable, or the secret is too short.
- The secret file is required only while no owner exists. It may remain
  configured after bootstrap but is never used as a general registration
  credential.
- **Never commit the bootstrap secret to version control, embed it in
  OCI images, or write it to application logs.** The `/api/auth/config`
  endpoint reports bootstrap availability but never leaks the secret value.

### Invite-only (subsequent accounts)

After bootstrap completes, registration transitions to invite-only:

- Only the existing owner may create an invitation through the web UI.
  Authorization is enforced server-side by user ID; the Better Auth `admin`
  plugin's HTTP endpoints remain inaccessible to all accounts.
- Each invitation produces a one-time URL containing a 32-byte random bearer
  token in the URI fragment:

  `https://<public-origin>/invite#token=<hex>`

  The fragment is never sent to the server in HTTP requests or written to
  standard proxy access logs. The invite page reads and clears it with
  `history.replaceState` before posting the token in its JSON body over TLS.

- Only the SHA-256 digest of the token is persisted in `workflow.db`. The
  raw token is returned exactly once — in the response that creates the
  invitation. The owner copies this URL out-of-band (Clipboard API) and
  delivers it to the intended recipient.
- Tokens are single-use, revocable, and expire after 7 days. The application
  never sends transactional email; delivery of the invitation link is the
  operator's responsibility.
- The recipient uses the link to set their name, email, and password through
  the invitation redemption flow, then signs in normally. The new account
  receives an active membership with no mutation capabilities.
- Invalid, revoked, expired, already-claimed, and already-redeemed tokens
  share a single public rejection message that does not enumerate the reason.

### Configuration

- `BETTER_AUTH_URL` must be set to the externally accessed HTTPS origin
  (e.g. `https://balanceframe.example.com`). It is used for auth callbacks
  and as the base when constructing invitation URLs.
- Public/open registration is not supported. Better Auth's `disableSignUp`
  is permanently enabled and the UI never exposes a sign-up form.
- Email verification is not implemented. The invite itself is the identity
  proof; no verification email is sent.
- All registration policy state (bootstrap completion, invitations) is
  stored in `workflow.db`, separate from Better Auth's authentication
  tables. The two databases are never coupled in a single transaction.

## Backward compatibility

### Existing-installation upgrade checklist

1. Record the running image tag/digest and the destination release's supported
   Actual Budget version. Pin both images; do not change credentials, volume
   paths, container users, or networks as part of a version-only upgrade.
2. Before starting the new image, retain recoverable backups of authentication,
   workflow, connection configuration, and the associated Actual installation.
   Keep private backups on trusted storage outside source control. Use SQLite's
   online backup API for a running database, or a documented quiesced backup
   procedure. Copying only a live `.db` file can omit committed WAL contents;
   missing `-wal`/`-shm` files alone do not establish backup consistency. Verify
   the backup's integrity and rehearse restoration on a disposable copy.
3. Pull and recreate only the intended service using the pinned image. Workflow
   migrations run automatically when the store is first opened, including during
   startup retention initialization. Better Auth runs its own migrations. There
   is no separate operator SQL command to run, and deleting `schema_version`,
   manually marking migrations complete, or recreating the database is not an
   upgrade procedure.
4. Check startup logs and `/api/health/ready`. A healthy container or successful
   `/api/health` response establishes liveness only. Require `workflowStore: ok`
   before treating the workflow upgrade as successful. A retention-unavailable
   warning can be a store-initialization failure; it is not proof of an OCR,
   filesystem-permission, or database-corruption problem.
5. Sign in with an existing user and verify explicit space selection, connection,
   and the expected read paths. Schema migration does not automatically create
   or select a space, bind a budget, reactivate membership, or grant financial
   authority. Instance ownership is not a substitute for selected-space grants.
   Follow the [space setup steps](../README.md#quick-start-docker) when setup is genuinely
   absent; do not use setup changes to mask an unavailable workflow store.
6. If initialization fails, preserve the original data and investigate a
   consistent disposable copy with the same image. Inspect the migration ledger
   and schema as well as integrity: integrity can pass while required tables are
   absent. Migrations commit individually, so a failed attempt may have applied
   earlier versions. Initialization errors are cached for the process lifetime;
   any eventual repair and restart need their own reviewed recovery plan.

Do not downgrade an already migrated database by changing only the image tag.
The workflow store rejects schema versions newer than its code supports. Use a
documented downgrade path or restore the matching pre-upgrade data and image as
a coordinated recovery operation, accounting for writes made since the backup.

The released-store regressions use synthetic persisted databases generated by
v0.4.0 (schema 11) and v0.8.0 (schema 27), then open them with current code and
reopen the results. They also cover an interrupted v0.4.0 upgrade at schema 12,
historical-data preservation, and denied authorization state. See the
[fixture provenance](../packages/workflow-store/test/fixtures/README.md);
this does not establish compatibility for every older or manually modified
installation.

#### v0.4.0 workflow upgrade failure in v0.5.0 through v0.9.0-beta.2

v0.4.0 shipped schema version 11. A later release added
`liquidity_claim_metadata` to the already released migration 10. Existing stores
skipped that migration, could commit version 12, and then failed migration 13
with `no such table: liquidity_claim_metadata`. Fresh-store tests did not
exercise this path. An intact database can therefore fail initialization; a
volume-permission change or a new Actual image does not correct the missing
migration prerequisite.

The correction ensures that prerequisite schema exists within migration
13's transaction before reading it, without fabricating historical metadata or
granting authority. Use a release containing the correction only after its
release checks pass. Do not run ad hoc SQL against a live store to imitate it.

For future changes, append schema migrations instead of adding required schema
only to an already released migration. Keep the released fixtures frozen and
add a new released fixture when expanding the supported upgrade baseline.
Upgrade regressions compare table, column, index, and foreign-key structure with
a fresh store and assert preservation of representative data and authorization
state. Structural parity does not prove every CHECK constraint or data
transformation correct; those changes still require targeted tests. A recovery
for an already blocked migration also needs a regression from its last committed
version; appending a later migration alone cannot unblock an earlier failure.

- A minor/patch upgrade on the same data volume must work without data loss or
  operator intervention beyond `docker compose pull && docker compose up -d`.
- SQLite schema migrations must be backward-compatible within a MINOR version
  — an older release must be able to start against a migrated database (or the
  migration must produce a documented downgrade path).
- Breaking schema changes are MINOR-bump events before `1.0.0` and MAJOR-bump
  events after.

## Release history

### v0.3.2 (2026-09-01)

- **Legacy owner access** — the workflow-store migration restores the current
  owner capability baseline, including dashboard, findings, and notification
  access, for an existing active instance owner while preserving custom
  capabilities and scope. Missing or inactive memberships remain denied.

### v0.3.1 (2026-08-23)

- **Invited-member read access** — invited accounts receive the read-only
  `observe` capability during atomic invitation redemption. The workflow-store
  migration repairs existing redeemed invitees without reactivating inactive
  memberships or changing mutation capabilities.

### v0.2.0 (2026-07-26)

- **Self-hosted registration** — two-state bootstrap/invite model replaces the
  disabled public sign-up. Adds persisted SQLite migration (version 3) for
  `registration_state` singleton and `invitations` table in `workflow.db`.
  Introduces new public HTTP routes and a server-side config endpoint.
- **Configuration change** — `BALANCEFRAME_BOOTSTRAP_SECRET_FILE` defines the
  operator bootstrap secret. The canonical `compose.yaml` mount reads from
  `./.bootstrap_secret` (hidden dotfile, gitignored). Inline
  `BALANCEFRAME_BOOTSTRAP_SECRET` remains available as an alternative.
- **Breaking (pre-1.0.0 MINOR)** — new required artifact and schema migration.
  See [Account lifecycle](#account-lifecycle-self-hosted-registration) above
  for setup instructions.
