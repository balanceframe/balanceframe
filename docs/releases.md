# Release Policy

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
4. The `release.yml` GitHub Actions workflow runs:
   - Nix flake checks
   - Workspace build, typecheck, lint, and tests
   - Rust workspace tests and clippy
   - Tag/version policy verification (`just release-verify`)
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

- **Owner dashboard access** — the workflow-store migration restores the
  read-only `observe` capability for an existing active instance owner while
  preserving current capabilities and scope. Missing or inactive memberships
  remain denied.

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
