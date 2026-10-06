# Release Policy

## Unreleased — Phase 11 merchant intelligence

- Local Rust analysis adds scoped merchant/category evidence, conservative recurrence/calendar reasoning and human alias, correction and pattern intent. Review, Dashboard and authenticated CLI share current source and authorization checks. Native Actual rule proposals retain complete simulation/provenance and execute independently of BalanceFrame; enrichment never supplies financial permission.
- Existing workflow databases use the store's transactional schema migration. Missing merchant policy remains local-only; old proposals or cached conclusions are not silently promoted into current evidence. Back up the workflow database before upgrade. Restore invalidates derived cache/decision reuse and retains outstanding billing holds; lifecycle deletion purges derived content without deleting Actual transactions, native rules or historical governance attribution.
- Optional ValueSerp research is **off by default**, absent from Sync, and requires installation, space and budget opt-in plus exact research grants and preview consent. `BALANCEFRAME_MERCHANT_CONFIG_PATH` names the bounded server-owned deployment JSON validated by [`merchant-settings.ts`](../packages/application/src/merchant-settings.ts); `VALUESERP_API_KEY` is a server-only secret, not a JSON/browser/Actual field. The JSON supplies versioned installation policy, credential identity/limits and account-confirmed tariff. Missing/invalid configuration or pricing refuses dispatch while local review remains usable. Use a dedicated key; scrub query-bearing provider URLs from deployment proxies, access logs and traces before enabling research.
- User export/delete and policy changes require current scoped authority and fresh human authentication. External request/attempt metadata, cache TTL and deletion fences follow the [Phase 11 retention contract](roadmap/post-mvp/11-merchant-intelligence-and-enrichment.md#5-retention-and-deletion-defaults); disable is not upstream erasure. No public-page scraping or automatic remote fallback is installed.
- Review/projection retention uses original server-captured expiry/age and derivation ownership, not reviewer assignment or read time. Private actor cleanup preserves shared, other-actor and independently known other-namespace bundles, including nested legacy copies; only removal of authoritative inferred target evidence supersedes pending Review. Human intent, canonical Money and plain nested canonical `sourceRevision` are preserved. Retired research attempts retain only opaque replay fences and exact billing/lease data; merchant-derived fingerprints are scrubbed for both private and shared requests.
- Observed compiled disposable SQLite retention smoke retires an unassigned private-owner Review bundle, preserves peer/shared copies before original expiry and a foreign known legacy namespace, then retires remaining selected derived copies at inclusive original expiry. Exact Money and ordinary nested canonical revisions survive; no Actual ledger mutation is performed.
- Disposable scenario startup reserves both loopback ports together, preventing immediate ephemeral-port reuse from confusing Nuxt readiness with Actual initialization. The deterministic failure regression and original startup/purchase targets pass without retries.

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
  Pre-releases never advance `vMAJOR`, `vMAJOR.MINOR`, or `latest` tags on the
  image registry.

## Release channels

| Channel               | Tag pattern     | Image tag semantics                                                    |
| --------------------- | --------------- | ---------------------------------------------------------------------- |
| **Stable**            | `vX.Y.Z`        | Immutable `vX.Y.Z`, mutable `vX.Y` and `vX` advance, `latest` advances |
| **Release candidate** | `vX.Y.Z-rc.N`   | Immutable `vX.Y.Z-rc.N` only; no convenience aliases                   |
| **Beta**              | `vX.Y.Z-beta.N` | Immutable `vX.Y.Z-beta.N` only; no convenience aliases                 |

## Release process

1. Update root `package.json` version to the release version (e.g. `0.1.4`).
2. Create an annotated Git tag: `git tag -a v0.1.4 -m "v0.1.4"`
3. Push the tag: `git push origin v0.1.4`
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
     - Release asset generation (`just release-assets`)
     - GitHub Release draft with all assets

## OCI registry

The sole OCI registry is **GitHub Container Registry** under the repository
owner's namespace:

```
ghcr.io/<owner>/balanceframe@sha256:<digest>
```

Immutable digest references are the canonical image identifier. Human-readable
tags (`vX.Y.Z`, `vX.Y`, `vX`, `latest`) are convenience aliases.

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
