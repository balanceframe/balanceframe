# BalanceFrame

[![CI](https://github.com/balanceframe/balanceframe/actions/workflows/test.yml/badge.svg)](https://github.com/balanceframe/balanceframe/actions/workflows/test.yml)
[![Release](https://img.shields.io/github/v/release/balanceframe/balanceframe)](https://github.com/balanceframe/balanceframe/releases)
[![Docker](https://img.shields.io/badge/Docker-ghcr.io-blue)](https://github.com/balanceframe/balanceframe/pkgs/container/balanceframe)
[![License: Apache 2.0](https://img.shields.io/badge/License-Apache%202.0-blue.svg)](LICENSE)

**AI-assisted budget categorization on top of [Actual Budget](https://actualbudget.org).**

BalanceFrame is an open-source, self-hostable intelligence and workflow layer
for household finance. It reduces the Actual Budget transaction-categorization
backlog by combining deterministic rules with machine learning, while keeping
the user in control of every decision.

## License and Governance

BalanceFrame is licensed under the **Apache License, Version 2.0**.
See [LICENSE](LICENSE) for the full license text. All contributors must
sign off their commits to certify compliance with the [Developer Certificate
of Origin](https://developercertificate.org/); see [CONTRIBUTING.md](CONTRIBUTING.md)
for details.

- [NOTICE](NOTICE) — Required attribution notices
- [THIRD_PARTY_NOTICES](THIRD_PARTY_NOTICES) — Dependency licenses and notices
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — Community standards
- [.github/SECURITY.md](.github/SECURITY.md) — Security vulnerability reporting

## Architecture

BalanceFrame is a **Rust–TypeScript modular monolith**:

```
┌──────────────────────────────────────────────────┐
│                 Applications                      │
│  ┌──────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ CLI  │  │   Web    │  │     Server       │   │
│  └──┬───┘  └────┬─────┘  └────────┬─────────┘   │
│     │           │                  │             │
│  ┌──┴───────────┴──────────────────┴──────────┐  │
│  │           N-API Bindings                    │  │
│  └──┬─────────────────────────────────────────┘  │
│     │                                            │
│  ┌──┴─────────────────────────────────────────┐  │
│  │         Rust Financial Core                 │  │
│  │  ┌──────────────┐  ┌──────────────────┐    │  │
│  │  │  financial-   │  │   core-protocol   │   │  │
│  │  │  core         │  │   (schemas,       │   │  │
│  │  │  (money,      │  │    validation,    │   │  │
│  │  │   rules,      │  │    versioning)    │   │  │
│  │  │   analysis)   │  │                   │   │  │
│  │  └──────────────┘  └──────────────────┘    │  │
│  └────────────────────────────────────────────┘  │
│                                                  │
│  ┌────────────────────────────────────────────┐  │
│  │         TypeScript Application Layer        │  │
│  │  ┌──────────┐ ┌──────────┐ ┌────────────┐ │  │
│  │  │ Actual   │ │ Inference│ │ Workflow    │ │  │
│  │  │ Adapter  │ │ Engine   │ │ Store      │ │  │
│  │  └──────────┘ └──────────┘ └────────────┘ │  │
│  └────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────┘
```

- **Rust** owns the financial core: checked money calculations, deterministic
  classification rules, financial validation, data-quality analysis, and the
  cross-language protocol schemas. Compiled via N-API for direct use from
  TypeScript.
- **TypeScript** owns the application layer: Actual Budget API integration
  (read-only for ledger queries; writes for categorisation mutations
  when authorised), model-provider orchestration for ML classification,
  workflow state management, CLI, and web UI.
- **N-API bindings** provide the bridge between Rust and TypeScript with
  versioned, coarse-grained calls.

## Features

- **Actual integration** — Connects to Actual Budget via the
  published `@actual-app/api` to observe transactions, categories, and
  budget state. Categorisation mutations are written only when explicitly
  authorised through the review-apply workflow (opt-in per deployment).
- **Transaction evidence** — Review camera/manual receipts, exact settlement
  allocations and human-attested wallet statements before separately approved
  Actual changes. [Workflow and acceptance limits](docs/transaction-evidence.md).
  Local OCR is optional; manual entry is always available.
- **Deterministic classification** — Rust-based rule engine that applies
  user-defined patterns and learned rules with full provenance.
- **ML-assisted suggestions** — Provider-neutral model orchestration that
  produces suggestion-only classifications for human review.
- **Exception review workflow** — A single prioritized inbox for
  uncategorized or ambiguous transactions (post-MVP).
- **Deterministic rule learning** — Repeated corrections become proposed
  deterministic rules, reducing model dependence over time (post-MVP).
- **Local-first and self-hosted** — No dependency on cloud services for
  core functionality; model providers are optional and swappable.

## Quick Start (Docker)

### Prerequisites

- [Docker](https://docs.docker.com/engine/install/) and [Docker Compose](https://docs.docker.com/compose/install/)
- An existing [Actual Budget](https://actualbudget.org) server (or follow the bundled setup below)

### Deploy BalanceFrame alongside an existing Actual server

```bash
# Download the latest release assets from the GitHub Releases page, then:
cp .env.example .env
# Edit .env: set BETTER_AUTH_SECRET (openssl rand -hex 32) and BETTER_AUTH_URL
docker compose up -d
```

BalanceFrame starts on port 3030 by default. Open `http://localhost:3030` in your
browser, log in, open **Connection**, and select the Actual budget to use.
The selected budget is persisted in the configured BalanceFrame data volume.

Create and select a space in **Spaces** before connecting. Connection binds the
budget to that space; it does not grant financial access. See
[financial access after connection](#financial-access-after-connection) before
opening Review or financial pages.

### Financial access after connection

Space membership and ownership do not imply permission to read financial data.
In **Spaces → Exact resource grants**, a grant manager explicitly selects the
current membership, capability, resource kind, exact resource ID, and any
restrictions. Saving a grant requires recent password confirmation. Grant only
the resources and capabilities the person intends to share; never use a wildcard
or copy a demo's grants into a real budget.

Budget selection and budget-kind grants use the public budget `id` returned by
budget discovery, not its SDK synchronization `groupId`. Account and category
grants use their exact Actual IDs, not their display names.

Reading the Review queue needs the selected budget's `observe` admission. Review
items also require current `existence` and `history` access to their exact
accounts, category `existence`, and separate `name` access for displayed labels.
An empty Review queue can mean those disclosure rights are missing, rather than
that the budget has no transactions. Running **Sync** and opening whole-budget
financial pages require explicit, resource-visible budget `observe` and
`full-read` grants without account/category narrowing or aggregate-only limits;
these disclose more than account-scoped Review access. Proposal, approval,
execution, notifications,
and governance controls retain their separate grants and confirmation checks.
See [the exact-authority model](docs/adr/0003-space-governance-and-exact-authority.md)
for membership periods, restrictions, and revocation behavior.

### Deploy BalanceFrame with a bundled Actual Budget server

For a new single-server setup include the optional overlay:

```bash
docker compose -f compose.yaml -f compose.actual.yaml up -d
```

After both services become healthy, connect BalanceFrame to `http://actual:5006`
through the application setup. Actual is independently upgradeable and
removable — removing BalanceFrame never deletes Actual data.

### Optional local receipt OCR

Photo receipts always support manual entry. Automatic text extraction is an
optional local sidecar with its own image and private network; core installation,
builds, startup and health do not require it. To opt in, explicitly run
`docker compose -f compose.yaml -f compose.ocr.yaml --profile receipt-ocr up -d --build`.
See [optional receipt OCR](docs/receipt-ocr.md) for pinned engines, resource bounds,
licenses, verification and disabling it. Review extracted text before saving facts.

### Optional ValueSerp merchant research

The canonical `compose.yaml` remains provider-off. This feature is an explicit
operator opt-in; adding the overlay supplies the server configuration path and
private key but does not grant research authority or consent.

Before enabling it:

1. Obtain the current tariff version, billing currency and exact unit price
   confirmed by the actual provider account. Set the account's approved
   versioned installation policy and credential caps (`maxSearchesPerDay` and
   `maxSpendMinorUnitsPerMonth`) using the
   [server deployment schema](packages/application/src/merchant-settings.ts).
   Public price pages, guessed values, sample tariffs and dummy caps are not
   deployment settings. If account-confirmed pricing or authorized caps are
   unavailable, keep research off.
2. Create the operator-owned JSON file at the path in
   `BALANCEFRAME_MERCHANT_CONFIG_FILE`. It must exist and be readable by the
   non-root BalanceFrame container user. The strict JSON schema does not accept
   the API key; do not put secrets in it.
3. Keep `VALUESERP_API_KEY` in a private, untracked deployment environment
   file (for example, mode `0600`). Rotate or revoke it through the provider
   account, replace the server-side value, and recreate the service after
   rotation. Never put the key in source control, browser settings, Actual, or
   the JSON file.
4. Before any external request, independently confirm that installation,
   selected-space and budget policies all allow the provider, current source
   authorization and exact scoped `merchant:research` grants are present, and
   the user explicitly consents to each operation. Ordinary authentication
   and CSRF checks remain in force. The overlay grants no wildcard, write or
   research authority.

Only after those prerequisites, explicitly select both compose files:

```bash
docker compose --env-file /secure/private/balanceframe.env \
  -f compose.yaml -f compose.research.yaml up -d
```

Set `BALANCEFRAME_MERCHANT_CONFIG_FILE` and `VALUESERP_API_KEY` in that private
environment file. The overlay mounts exactly one file read-only at
`/run/secrets/merchant-research.json` and refuses to create a missing host
source path. No provider settings are mounted or passed by the canonical
compose command.

#### Offline and redaction checks

Before deployment, run the offline Compose validator and sentinel regression:

```bash
COMPOSE_BIN=/path/to/docker-compose tests/deployment/compose-validate.sh
COMPOSE_BIN=/path/to/docker-compose node --test tests/deployment/compose-research.test.mjs
```

`COMPOSE_BIN` may name a standalone Compose renderer; without it, the checks use
`docker compose`. These checks render private sentinel values to Compose JSON
for semantic parsing and do not start services or contact a provider. They
prove local manifest isolation and output suppression only, not deployed
redaction.

Before enabling egress, verify every logging and observability boundary using
synthetic sentinels with outbound provider traffic blocked:

- Check application/container stdout and stderr, reverse-proxy access/error
  logs, APM traces, exception capture, and retained/exported logs.
- Confirm the entire outbound URL including its query, authorization and other
  sensitive headers, request/response bodies, and secret values are suppressed
  at each boundary. A path-only URL redaction is insufficient.
- Search captures and their exports for each sentinel; if any collector cannot
  be verified, leave external research off. This repository has no deployed
  proxy/APM environment, so no deployed redaction result is claimed.

Any eventual live check requires separate operator authorization, the actual
account-confirmed price and caps, and an explicitly bounded single
public-business request. Do not send transaction or financial details; stop
after that one request or on uncertain billing. No paid request or service
deployment is part of these local checks.

Review the account's applicable terms and upstream retention before opt-in.
Local deletion cannot recall dispatched queries or prove erasure by the provider.
Use the same explicitly selected overlay files for upgrades and key rotation;
the canonical upgrade command below intentionally leaves research disabled.

### Upgrade

```bash
docker compose pull && docker compose up -d
```

See [docs/releases.md](docs/releases.md) for the SemVer and upgrade policy.

## Development

### Prerequisites

- [Nix](https://nixos.org/download) with flakes enabled (recommended)

### Development Environment

```bash
nix develop
```

This drops you into a shell with Rust, Node.js, pnpm, and all native build
dependencies. If you are not using Nix, see `nix/tooling.nix` for the
required tool versions.
Supported Node releases are **22.19+ within 22.x, 24.11+ within 24.x, or 26+**;
Nix, CI, and Docker use Node 24. Node 20 is no longer supported.

### Build and Test

```bash
# Rust core
cargo build
cargo test

# TypeScript packages
pnpm install
pnpm build
pnpm test

# Full flake check
nix flake check
```

Scenario tests consume the workspace's production Nuxt bundle. The production
dependency regression builds its own disposable `.nuxt` and `.output` directories
so parallel workspace tests never lose or replace that shared runtime.

Dependency maintenance:

- Vitest and its V8 coverage provider move together. Explicit coverage includes
  retain unimported production files; the coverage gates are unchanged.
  The scenario CLI streams raw test output so passing verification JSON remains
  visible and parseable even when terminal colors are enabled.
- The install-script allowlist includes `vue-demi`'s local Vue-version export
  selector. Docker builds use source inputs, not host dependencies or build outputs.
- `patches/` contains version-specific compatibility fixes for Nitro 2.13.4's
  Archiver 8 ZIP API and Nuxt DevTools 3.4.2's Vite environment configuration.
  Frozen installs and Docker builds require these patch files. Remove a patch
  only after an upstream fix passes the real ZIP/RPC regressions in
  `apps/web/test/server/`.
- Icons use the installed Heroicons and Lucide datasets through Nuxt's local
  server provider rather than fetching missing collections from a public API.
- Typography uses the system font stack, so remote font-catalog discovery is disabled.
- Nuxt UI consumers use `UFormField` and `UFieldGroup`. Resolve `useToast` during
  component setup so asynchronous notifications retain the app's injected limits.
- Better Auth's SQLite migrations finish before authentication initialization and
  schema validation; migration failures keep protected/auth APIs unavailable.
- Rolldown's callback/link-time profiling advisory is disabled; correctness,
  security, import-protection, and deprecation diagnostics remain enabled.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete development workflow.

### Disposable feature scenarios and demo

After `nix develop`, install dependencies and build the workspace from source (`pnpm install && pnpm build`).
The native addon, Actual server, and production Nuxt bundle must be available; a browser-only mock cannot run these financial flows.
Scenario fixture packaging uses Node filesystem APIs, so the build does not require POSIX `mkdir` or `cp` commands on Windows.

```bash
pnpm scenarios list
pnpm scenarios verify funded-purchase
pnpm scenarios verify merchant-native-rule-lifecycle
pnpm scenarios verify evidence-plural-allocation
pnpm scenarios verify --all
pnpm scenarios verify --faults
pnpm scenarios run funded-purchase
pnpm demo --scenario rich-cart
pnpm demo --scenario governance-scoped-access
pnpm demo --scenario merchant-research-lifecycle
pnpm demo --scenario evidence-receipt-intake
```

`run` and `demo` open the shared fictional workspace at `http://127.0.0.1:3003/demo` by default. Select a story, follow **Open active scenario** to its ordinary application screen, and use **Reset shared demo** to discard all changes and regenerate that scenario. The selector and banner identify the fictional persona and warn that anyone sharing this instance sees its changes. Stop the supervisor with Ctrl-C; it removes only its own disposable workspace. Never connect it to a personal or production Actual budget.

`verify --all` runs all **45** independently loadable authenticated Actual/Nuxt stories and their required behavior branches, then the separately labeled native/service fault contracts. Each passing case emits a JSON verification record with catalog version, scenario ID, anchor, assertion count, branches, and sanitized evidence mode. Missing stories or branches fail verification even if Vitest exits zero. The fault contracts test ambiguous transfer, coverage receipts, authoritative schedule identity, interrupted completion writes, and the evidence failures described below without pretending to provide live-bank proof. `verify --faults` runs only those contracts. For a local HTTPS reverse proxy, a non-loopback listener additionally requires `--host` and an exact `--origin https://…`; restrict network access to that proxy and use disposable state only. See [Actual integration scenarios](tests/actual-integration/README.md) and [ADR 0002](docs/adr/0002-owned-disposable-scenario-demo.md).

Scenario account attestations are explicit, fictional source evidence, not bank imports; missing or expired attestations keep the Card at `insufficient_data`. Reset regenerates only the active instance's credentials, budget, sessions and attestations; another runner is independent.
Catalog policy, observation and session expiry durations are materialized at their real submission time, so a fixed historical `--anchor` does not submit an already-expired configuration. Ordinary fixture timestamps remain unchanged; deliberately short expiry stories retain their short lifetime.
Shared demo load/reset controls enforce a ten-second monotonic cooldown after each attempt; membership, authentication and financial freshness checks keep real time.

Scenario setup creates real personal/shared spaces and installs exact resource grants with development authentication bypass disabled. Active human personas have independent Better Auth credentials and selected-space cookies. Pending invitations have no invented user/session; redemption creates a real separate human membership, and rejoining creates a new membership without inherited grants. The assistant uses a real bounded agent/delegation/API-key binding, not a human login. In the disposable browser demo, type **CONFIRM** for the current fictional persona's guarded actions: this renews Source's real session-bound proof without revealing fictional passwords. Ordinary Source accounts still require their own current password.

Scoped completion approvers have explicit selected-budget liquidity admission for Native Card revalidation and exact grants for their completion's canonical accounts and categories. Persona roles infer no private history/source/full-read, execution, or control authority.

#### Release coverage and walkthroughs

The existing 29 spending stories remain selectable, covering v0.5.0 rich carts, opportunity costs and reservations alongside liquidity routing, completion and reconciliation. `coapproval-completion` additionally demonstrates independently attributed approvals, existing space-scoped audit access, actor filters, financial-detail redaction and denial without audit rights.

| Release | Scenario                          | Entry and expected behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| v0.6.0  | `governance-scoped-access`        | `/spaces`: separate limited human, Checking name/existence only; exact grant changes and membership revocation withhold other resources and financial data.                                                                                                                                                                                                                                                                                                                                                                                       |
| v0.6.0  | `governance-invitation-lifecycle` | `/spaces`: pending invitation → separate-person redemption → revoke/rejoin with a new membership and no old grants.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| v0.6.0  | `governance-delegated-assistant`  | `/spaces`: **Probe bounded assistant access** in demo controls displays admitted native Checking metadata and blocked management/history/financial HTTP outcomes; **Revoke assistant delegation**, then probe again to see the same key rejected with 401.                                                                                                                                                                                                                                                                                        |
| v0.7.0  | `merchant-local-sparse`           | `/review`: run **Sync**; Aster's $346.07 debit suggests Groceries from three real categorized observations, with no research/provider call.                                                                                                                                                                                                                                                                                                                                                                                                       |
| v0.7.0  | `merchant-local-insufficient`     | `/review`: one categorized observation and an empty-identity target abstain rather than inventing a confident category or rule.                                                                                                                                                                                                                                                                                                                                                                                                                   |
| v0.7.0  | `merchant-alias-conflict`         | `/review`: imported Aster text versus Dapple notes abstains; independently reset alias confirm/reject decisions persist versions without ledger edits. A normal independently approved correction to Other wins subsequent inference.                                                                                                                                                                                                                                                                                                             |
| v0.7.0  | `merchant-recurrence-calendar`    | `/review` and Dashboard: monthly, civil month-end, US business-end/first-business-day, variable $9–$12 and irregular series; independent pattern accept/reject branches. Clearing the calendar or selecting an unsupported jurisdiction preserves ordinary cadence with uncertainty. Local calendar fixtures also cover leap/year and unsupported-year boundaries.                                                                                                                                                                                |
| v0.7.0  | `merchant-native-rule-lifecycle`  | `/rules` and Review: select Aster's $749.65 queue row and inspect the exact rule impact. **Proposed rules** remains accessible to scoped reviewers with empty transaction queues. Two independent human approvals exclude the author; owner execution creates one real Actual rule, with idempotent replay checked by local acceptance. **Simulate fixture import** uses Actual alone on Savings. Reset, prepare and approve a fresh unexecuted proposal, then **Change native fixture source** and attempt execution: refusal leaves zero rules. |
| v0.7.0  | `merchant-research-success`       | `/review`: explicitly consent to merchant-only fixture research; observe fixture provenance, cache reuse and **Expire fixture research cache** expiry.                                                                                                                                                                                                                                                                                                                                                                                            |
| v0.7.0  | `merchant-research-outage`        | `/review`: consent returns a modeled provider outage/uncertain billing; local Sync and Review remain usable.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| v0.7.0  | `merchant-research-lifecycle`     | `/review`: held research, non-draining release/cancel/reset, installation/space/budget or exact-grant revocation, daily/monthly limits, and normal deletion with late-result fencing. Each mutually exclusive branch starts from a fresh load.                                                                                                                                                                                                                                                                                                    |

Use the selector's declared entry links, persona selector and event controls; normal application authorization, fresh proof, approval and version checks still apply. After switching personas or reopening a guarded normal screen, enter `CONFIRM` in that screen's fresh-confirmation form before making changes; return to demo controls for fixture events. Governance name/existence probes are bounded local tooling backed by the real principal, governance engine and Actual metadata—not a new production resource-list endpoint.

Native-rule reviewers receive finite full-read/approval rights for the complete current Actual source graph and exact published evidence, including generated baseline IDs; they receive neither budget-wide full-read nor execution/control rights. The owner receives only that story's required native-rule intent authority on those resources, not generic write rights for generated balances. Imports and newly created rules extend the same exact native-ID scope through validated normal grant handlers.

Research is a **closed fixture provider through the real coordinator, policies, cache and quota journal**. It never constructs a provider transport, reads paid keys, calls ValueSerp, or falls back to live research. `.invalid` sources are synthetic and uncalibrated; the modeled USD tariff is 250000 atoms ($0.0025) per dispatch, not a live provider price. Only the bounded research clock advances; source freshness and human proof use real time. Disabling or retiring fixture authority fails closed, and reset cancels held work before draining requests. This remains one shared disposable runtime, not per-visitor isolation or a static browser demo.

#### Transaction evidence walkthroughs (v0.9.0)

All five evidence stories open `/review#transaction-evidence` and offer owner, two independent approvers,
and restricted personas. They import fictional source documents through the normal
authenticated ingestion path. Imported labels, balances and category hints grant no
authority; reviews, attestations and approvals remain separate user actions.

| Scenario                     | Seed and walkthrough                                                                                                                                                                                                                                                                                                                                                                                                |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `evidence-receipt-intake`    | Inspect a $12 camera photo with manual fields, a manually entered PDF invoice, an unparsed PDF and an item-total mismatch. Use **Add receipt** for another fictional photo or document. Extraction is absent by default; manual review and original-source access remain available to the scoped owner.                                                                                                             |
| `evidence-plural-allocation` | Allocate two $6 receipt lines across existing $7 and $5 settlements and Groceries/Household categories. Review the matrix, prepare the governed proposal, collect both independent approvals, then execute and reread the resulting native splits. Local verification also denies stale hashes, wrong-document grants, requester approval and one-approval execution, and checks replay creates no additional rows. |
| `evidence-return-lifecycle`  | Review a $12 purchase, $6 partial return, $7 excess return, replacement and separate order. Link or clear return, member and fulfillment assignments; revoke the fictional member and inspect historical attribution. Preview a replacement receipt version, revoke the old version, and verify unrelated evidence remains intact.                                                                                  |
| `evidence-wallet-statement`  | Inspect an imported statement whose balance authority starts unknown. Explicitly attest its exact contents as human-reviewed, examine coverage/gaps/conflicts, and revoke the attestation. Prepare a $2 opening-equity wallet proposal, obtain both independent approvals and execute once. This is human-attested local evidence, never provider-authenticated proof.                                              |
| `evidence-categorization`    | Review two independent granola receipts. Confirm item outcomes, inspect the learned candidate, simulate and approve a deterministic rule, then inspect or revoke its suggestion. Local/external model automation stays disabled; manual decisions work without providers, credentials or OCR.                                                                                                                       |

For each story, run `pnpm scenarios verify <scenario-id>` to exercise its registered
acceptance branches against a fresh disposable Actual budget and real Better Auth
sessions. Reset replaces the active story's documents, grants, review state, budget
and credentials; repeating verification does not reuse earlier approvals or writes.
The CLI performs governed writes only in the fictional budget it owns.

For plural allocation, enter $4/$2 for the first receipt line across the $7/$5
settlements, and $3/$3 for the second line. Assign Groceries to the first line
and Household to the second. Each approver must explicitly review and save that
same matrix on `/review#transaction-evidence` under their own persona before reviewing the owner's
proposal link. Allocation reviews are actor-scoped; switching personas never
copies or silently attests another person's review. Return to the owner for
execution after both approvals.

`pnpm scenarios verify --faults` additionally exercises absent/failing OCR with
manual fallback, ambiguous allocation and opening-equity acknowledgments with
durable recovery, and held categorization results invalidated by consent, source,
policy or grant revocation. These cases emit `fault-verification` records labeled
`synthetic-evidence-service-fault`, use service/native contracts and a captured SDK
transport, and report `actualWrite: false`. They are not browser/Better Auth/Actual
scenario records. The ordinary demos do not install a fake production inference
provider or transmit receipt data. Email forwarding remains deferred.

#### Complete Review measurements (Linux)

With the same source build and an installed Chromium/Chrome, run the real
Actual → authenticated Sync → persisted queue → rendered Review path:

```bash
taskset -c 0,1 node scripts/merchant-intelligence/review.mjs \
  --sizes 50000,250000 --warmups 2 --iterations 20 \
  --deadline-ms 120000 --dataset-deadline-ms 3300000 \
  --chromium-path /opt/google/chrome/chrome --output /tmp/review-local-reference.json
```

Choose an unused output path and your installed browser path. Use an owned
resource supervisor on a shared host; the reference runs use a 12 GiB whole-job
cap with no swap, separate from the reported approximate Actual/web entry RSS.
The tool creates only disposable fictional budgets, compacts their sync history
with native `sync-reset`, verifies independent financial readback and reconnects
the same budget under its new sync group. No production budget or paid provider
is used. First queue population is separate from the warmed 2+20 p95; neither
is a cold-start or native-only measurement. Full Review p95 is descriptive;
the existing native latency/memory gates are unchanged. Short, failed or censored
datasets have no affirmative reference p95; incomplete reports exit 2.
Reports/screenshots are private and exclusive. Normal handled runs clean up
owned services/data unless SDK shutdown is unproven. External OOM/SIGKILL can
bypass report finalization and cleanup: retain the owning supervisor's failure
evidence, verify its cgroup is released, then remove only its recorded disposable
workspace. An externally killed run establishes no reference p95.
The CI publication test reports specific allowlisted Sync failures, HTTP status
counts and page-error counts; it never prints private reports, cookies or ledger rows.
The Linux full-suite CI job allows 90 minutes for serial scaled Actual proofs and
instrumented scenario coverage. This job limit is not a UI/native performance target.
Actual-adapter test files run serially so the 250,000-row retention check does not compete with credential-key derivation. Its 10-second test timeout, dataset and exact-money/ID assertions remain unchanged.

The separate real-fixture allocation regression is
`node --test scripts/merchant-intelligence/review-grants.test.mjs`, run serially
in the locked source environment. Its isolated grant-write RSS ceiling is an
operational regression check, not the native analysis memory gate; it is not
part of the ordinary unit suite.

### Release

```bash
# Enter the release shell (adds Docker, Cosign, Syft, etc.)
nix develop .#release

just release-verify v0.1.4
just release-assets v0.1.4 sha256:<64-hex-digest>
```

See [docs/releases.md](docs/releases.md) and
[.github/workflows/release.yml](.github/workflows/release.yml) for the
full release process.

### Coverage

```bash
# After pnpm install and pnpm build, run the complete serial coverage gate.
# Default HEAD includes staged, unstaged and untracked source changes.
nix develop --command just coverage

# Compare complete changed source files since an available branch/ref.
nix develop --command just coverage origin/main

# Recheck existing reports without rerunning tests.
node scripts/coverage/check.mjs --base origin/main --require-execution
```

**Report locations** (relative to project root):

| Layer                  | Report                                               | Path                                        |
| ---------------------- | ---------------------------------------------------- | ------------------------------------------- |
| JS/TS                  | LCOV (per package)                                   | `coverage/js/<package>/lcov.info`           |
| JS/TS                  | JSON (per package)                                   | `coverage/js/<package>/coverage-final.json` |
| CLI runtime entrypoint | Real child-process V8 LCOV                           | `coverage/js/cli/entrypoint-lcov.info`      |
| Rust                   | Authoritative LLVM per-file line summaries (JSON)    | `coverage/rust/coverage.json`               |
| Rust                   | LCOV (workspace, for coverage viewers)               | `coverage/rust/lcov.info`                   |
| All                    | Threshold results, weighted totals and failures      | `coverage/summary.json`                     |
| JS/TS suites           | Execution evidence (no failed/skipped/pending tests) | `coverage/js/<package>/tests.json`          |

**Inclusion/exclusion:**

- JS V8 coverage includes all production source, including unimported files:
  package `src/` and `bin/`, declared `main` / `module` / `bin` / `exports` source
  targets, and Nuxt `app/`, `server/`, `lib/`, `composables/`, `types/` and
  `nuxt.config.ts`. The runner passes the discovered inventory to V8's include-all
  provider. Tests, fixtures, declarations, and build/dependency output are not
  production. Canonical generated validators remain in scope. New workspace
  packages and source files are discovered. Required reports always fail closed
  when missing or malformed. Missing source records fail unless the source is
  strictly type-only TypeScript (checked with the TypeScript AST), or conservative
  Rust declarations with no function, implementation, constant, static or macro
  invocation syntax. Existing provider counts are never discarded. Missing records
  classified as non-executable are listed in `nonExecutableSources` and contribute
  no artificial covered lines.
- Rust uses the standard LLVM JSON per-file `summary.lines` metrics across the
  workspace. These authoritative totals can differ from LCOV `DA` record counts;
  LCOV remains available for coverage viewers.
  External tests and test-only `fuzz.rs` / `phase_85_tests.rs` modules are excluded.
  The runner uses matching LLVM tools from the development environment, an isolated instrumented
  native build and real Node/N-API consumers; the live native addon is not replaced.
  Linux GDB fault injection also exercises real N-API host-registration failures
  that cannot be reached through successful addon loading; no production counters
  are excluded. GDB is a required coverage prerequisite in the development shell.
- Live Actual tests use the existing disposable fixture setup on a fresh loopback
  port and private data directory. Before any consumer runs, inherited `ACTUAL_*`,
  `BALANCEFRAME_*` and `NUXT_*` settings are cleared. Actual receives an explicit
  private empty configuration; connection, credential-vault, workflow and auth paths
  point into disposable storage. The runner restores any prior `.env.test` and
  stops its own verified fixture on exit. On direct INT/TERM, it terminates the
  owned command group (including descendants) and reaps its child before restoring state.
  Local coverage uses Linux `setsid` and `/proc`, as does the Linux CI job.
  Missing prerequisites or skipped integration tests are failures, not opt-outs.
- Source-free and wholly non-executable packages report **N/A**, never artificial 100%;
  contract/integration suites must still pass with no skipped tests. Test scripts
  and discovered test files independently make a suite mandatory: deleting its
  coverage script fails configuration rather than opting it out.

**Line thresholds** apply both to each package total and to the aggregate of
changed production-source files within that package (not changed lines or
individual tiny files):

| Package                                                             | Minimum |
| ------------------------------------------------------------------- | ------- |
| `crates/financial-core`, `crates/core-protocol`                     | 95%     |
| `crates/node-binding`, `packages/protocol-generated`                | 90%     |
| `tests/contract` (where production source exists)                   | 100%    |
| `tests/actual-integration` (where production source exists)         | 90%     |
| Every other code package, including coverage checker infrastructure | 80%     |
| Line-weighted workspace total                                       | 80%     |

CI fetches history and supplies the pull-request base SHA. Local comparison uses
the merge base with `HEAD`, plus working-tree and untracked sources. An unavailable
base, malformed report, missing report/source, or threshold failure exits nonzero.
Before pushing a pull request, use its base SHA (the CI job's `COVERAGE_BASE`)
or a freshly fetched target branch. The default `HEAD` changed-file gate only
covers uncommitted changes, not earlier PR commits.
The checker and runner isolation/cancellation contracts have executable behavior tests:
`pnpm test:coverage-gates`.

## Project Status

BalanceFrame is in **initial release.** The current stable version is
**v0.1.4**. The roadmap is documented in detail at

## Related Projects

- **[Actual Budget](https://actualbudget.org)** — The open-source personal
  finance tool that BalanceFrame integrates with.
- **[Actual AI](https://github.com/sakowicz/actual-ai)** — MIT-licensed
  project that provided conceptual inspiration; no source code is
  incorporated.

## License

Copyright 2026 BalanceFrame contributors. Licensed under the Apache License,
Version 2.0. See [LICENSE](LICENSE) for the full license text.
