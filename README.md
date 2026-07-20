# BalanceFrame

**AI-assisted budget categorization on top of [Actual Budget](https://actualbudget.org).**

BalanceFrame is an open-source, self-hostable intelligence and workflow layer
for household finance. It reduces the Actual Budget transaction-categorization
backlog by combining deterministic rules with machine learning, while keeping
the user in control of every decision.

## License and Governance

BalanceFrame is licensed under the **Apache License, Version 2.0**.
See [LICENSE](LICENSE) for the full license text. All contributors must
sign off their commits to certify compliance with the [Developer Certificate
of Origin](https://developercordificate.org/); see [CONTRIBUTING.md](CONTRIBUTING.md)
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
  (read-only initially), model-provider orchestration for ML classification,
  workflow state management, CLI, and web UI.
- **N-API bindings** provide the bridge between Rust and TypeScript with
  versioned, coarse-grained calls.

## Features

- **Read-only Actual integration** — Connects to Actual Budget via the
  published `@actual-app/api` to access transactions, categories, and
  budget state without modifying the ledger.
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

## Quick Start

### Prerequisites

- [Nix](https://nixos.org/download) with flakes enabled (recommended)

### Development Environment

```bash
nix develop
```

This drops you into a shell with Rust, Node.js, pnpm, and all native build
dependencies. If you are not using Nix, see `nix/tooling.nix` for the
required tool versions.

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

See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete development workflow.

### Coverage

```bash
# Full coverage (JS/TS + Rust) from the Nix development environment
nix develop --command just coverage
```

**Report locations** (relative to project root):

| Layer | Report | Path |
|-------|--------|------|
| JS/TS | LCOV (per package) | `coverage/js/<package>/lcov.info` |
| JS/TS | JSON (per package) | `coverage/js/<package>/coverage-final.json` |
| Rust | LCOV (workspace) | `coverage/rust/lcov.info` |
| All | Machine-readable index | `coverage/summary.json` |

**Inclusion/exclusion:**

- JS/TS coverage includes `src/**` source files only; tests, fixtures, build
  output (`dist/`), and `node_modules/` are excluded.
- Rust coverage includes all workspace crates; dependencies and the `target/`
  directory are excluded by `cargo llvm-cov`.

**Coverage thresholds:** JS/TS and Rust are measured and reported independently.
No unified project-wide percentage is calculated. Existing policy targets are
documented in `AGENTS.md`; CI currently publishes reports without enforcing
those targets, so the first baseline can be reviewed before adding gates.

## Project Status

BalanceFrame is in **pre-release planning and implementation.** The roadmap
is documented in detail at [docs/roadmap/overview.md](docs/roadmap/overview.md).

### Current Phase

**Phase 0** — Actual baseline and technical proof: proving stock Actual
integration and the Rust–TypeScript contract before product workflow
implementation.

### Roadmap

| Phase | Outcome |
|-------|---------|
| 0 | Actual baseline, Rust–TypeScript contract, N-API proof |
| 1 | Read-only Actual gateway and deterministic Rust analysis |
| 2 | Provider-neutral, suggestion-only ML classification |
| 3 | Fast exception review workflow (MVP validation gate) |
| 4 | Approved, recoverable category writes |
| 5 | Inspectable rule learning with historical simulation |

Phases 6–10 cover spaces, governance, budget intelligence, and linked-space
coordination. See the [full roadmap](docs/roadmap/overview.md) for details.

## Related Projects

- **[Actual Budget](https://actualbudget.org)** — The open-source personal
  finance tool that BalanceFrame integrates with.
- **[Actual AI](https://github.com/sakowicz/actual-ai)** — MIT-licensed
  project that provided conceptual inspiration; no source code is
  incorporated.

## License

Copyright 2026 BalanceFrame contributors. Licensed under the Apache License,
Version 2.0. See [LICENSE](LICENSE) for the full license text.
