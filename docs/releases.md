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

| Channel | Tag pattern | Image tag semantics |
|---|---|---|
| **Stable** | `vX.Y.Z` | Immutable `vX.Y.Z`, mutable `vX.Y` and `vX` advance, `latest` advances |
| **Release candidate** | `vX.Y.Z-rc.N` | Immutable `vX.Y.Z-rc.N` only; no convenience aliases |
| **Beta** | `vX.Y.Z-beta.N` | Immutable `vX.Y.Z-beta.N` only; no convenience aliases |

## Release process

1. Update root `package.json` version to the release version (e.g. `0.1.0`).
2. Create an annotated Git tag: `git tag -a v0.1.0 -m "v0.1.0"`
3. Push the tag: `git push origin v0.1.0`
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

## Backward compatibility

- A minor/patch upgrade on the same data volume must work without data loss or
  operator intervention beyond `docker compose pull && docker compose up -d`.
- SQLite schema migrations must be backward-compatible within a MINOR version
  — an older release must be able to start against a migrated database (or the
  migration must produce a documented downgrade path).
- Breaking schema changes are MINOR-bump events before `1.0.0` and MAJOR-bump
  events after.
