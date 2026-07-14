# Phase 00 — Development environment setup

**Precedes:** every other roadmap phase  
**Status:** Upcoming

## Objective

Establish a reproducible, pinned Nix Flake as BalanceFrame's canonical development environment. Every project tool used to build, test, format, lint, package, verify, or inspect the Rust–TypeScript modular monolith must be available through `nix develop`; contributors must not depend on ambient system package versions.

Phase 00 intentionally does **not** renumber the existing implementation phases. It is numbered `00` to make its prerequisite position explicit: Phase 0's Actual/API proof begins only after the toolchain environment is reproducible.

## Design

Adopt the modular Flake shape used as inspiration by [KOReader Companion](https://github.com/kor-companion/koreader-companion): a small root `flake.nix` declares inputs and cross-system outputs, while root-level `nix/` modules own the dev shell and Flake checks. BalanceFrame must implement its own package selection and checks; the reference is design inspiration, not copied configuration.

```text
flake.nix
flake.lock
nix/
  dev-shell.nix
  checks.nix
  tooling.nix              # optional shared tool definitions
.envrc                     # optional direnv entrypoint; nix develop remains canonical
```

The root flake must expose, per supported development system:

- `devShells.default` — the canonical developer environment;
- `formatter` — the canonical Nix formatter;
- `checks` — reproducible repository checks runnable with `nix flake check`;
- `packages` only when a project artifact is ready to package; do not manufacture placeholder packages.

Use a committed `flake.lock`. Pin `nixpkgs` and update it deliberately through a documented reviewable workflow. The initial target matrix is `x86_64-linux` and `aarch64-linux`, matching initial released native-addon support. Add `x86_64-darwin` and `aarch64-darwin` only when the shell/checks actually evaluate and the project supports contributor development on them; never advertise an untested system.

## Required dev-shell tooling

The shell must provide the tooling already required or implied by the roadmap:

| Area | Tools/capabilities |
|---|---|
| Rust financial core and N-API addon | stable Rust toolchain, `cargo`, `rustc`, `rustfmt`, `clippy`, `rust-analyzer`, `cargo-nextest`, `cargo-audit`, `cargo-deny` |
| TypeScript/Node application | a pinned Node.js runtime, Corepack or the selected package-manager bootstrap, TypeScript/tooling dependencies through the repository lockfile, and Node native-addon build support |
| Native dependencies | `pkg-config`, OpenSSL development libraries, SQLite CLI/libraries, compiler/linker tooling required by the declared N-API dependency graph |
| Repository workflow | Git, `just` if adopted, `jq`, Python 3 for repository scripts, and the canonical Nix formatter (`nixfmt`) |
| Development diagnostics | Linux-only tools only when useful to the supported workflow; platform-specific packages must be conditionally included rather than breaking non-Linux evaluation |

The shell hook may print concise orientation and canonical commands, but it must not mutate lockfiles, install unpinned dependencies, download secrets, start services, rewrite project files, or hide setup failure. Secrets remain outside the Flake and are injected through documented environment/secret-file paths.

Do not include a model runtime, Actual server, broker, Kubernetes, Docker daemon, database server, or frontend-specific toolchain until a later phase proves it is needed. The environment supplies development tooling; it does not prematurely define deployment topology.

## Checks and contributor contract

Implement Flake checks that can be evaluated before application code exists, then extend them as code lands:

1. `nix flake show` exposes the documented outputs for the current system.
2. `nix flake check` evaluates Flake wiring, module imports, formatter output, shell construction, and initial static repository checks without relying on undeclared host tools.
3. `nix develop --command` can invoke the Rust, Node, Git, JSON, Python, SQLite, formatter, and native-build tools expected by the shell.
4. The shell runs on every advertised system without a Rust compiler, Node runtime, or package manager preinstalled globally.
5. Tool versions are inspectable and derive from the locked Flake/repository lockfiles.
6. Future CI uses the same Flake checks/tooling contract rather than a separately assembled CI environment.

Document the canonical contributor path:

```bash
nix develop
nix flake show
nix flake check
```

`direnv` may be supported through `.envrc`, but it is optional convenience. `nix develop` remains the portable and documented entrypoint.

## Acceptance criteria

- `flake.nix`, `flake.lock`, and the root `nix/` modules exist and are reviewed as source-controlled project infrastructure.
- A clean supported host enters `nix develop` and receives all required Rust, Node/TypeScript, native-build, formatting, repository, and verification tools without ambient package installation.
- `nix flake check` succeeds for each advertised system; the output matrix and formatter are visible through `nix flake show`.
- The shell does not broaden the project scope, materialize secrets, mutate the repository, or couple development to an Actual server, model provider, hosted service, or microservice fleet.
- Phase 0 can rely on this environment for Actual API proof, Rust protocol fixtures, N-API artifact work, and future checks.

## Reference consulted

- [KOReader Companion `flake.nix`](https://raw.githubusercontent.com/kor-companion/koreader-companion/main/flake.nix)
- [KOReader Companion `nix/dev-shell.nix`](https://raw.githubusercontent.com/kor-companion/koreader-companion/main/nix/dev-shell.nix)
- [KOReader Companion `nix/checks.nix`](https://raw.githubusercontent.com/kor-companion/koreader-companion/main/nix/checks.nix)
