# Contributing to BalanceFrame

Thank you for your interest in contributing to BalanceFrame! This document
outlines the process for contributing, the standards we follow, and the
legal requirements for your contributions.

## Code of Conduct

All contributors and maintainers are expected to adhere to our Code of
Conduct. Please read [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) before
participating. In short: be respectful, assume good faith, and make this
a welcoming community for everyone.

## Developer Certificate of Origin (DCO)

BalanceFrame requires that every commit is signed off to certify that the
contributor has the right to submit the contribution under the terms of the
project's Apache License, Version 2.0. This is the **Developer Certificate
of Origin (DCO)**, version 1.1, available at:

  https://developercertificate.org/

Every commit must include a `Signed-off-by` line:

```
Signed-off-by: Your Name <your.email@example.com>
```

The simplest way to add this is to use `git commit -s` (or `git commit
--signoff`). If you forget, you can amend a commit with:

```
git commit --amend --signoff
```

Commits without a valid `Signed-off-by` line will not be accepted into the
repository.

By signing off, you certify that:

- The contribution was created in whole or in part by you and you have the
  right to submit it under the applicable license; or
- The contribution is based on previous work that, to the best of your
  knowledge, is covered under an appropriate open source license and you
  have the right under that license to submit that work with modifications;
  or
- The contribution was provided directly to you by some other person who
  certified the above, and you have not modified it.

## How to Submit Changes

1. **Fork the repository** on GitHub.

2. **Create a feature branch** from the default branch (usually `main`):

   ```bash
   git checkout -b feat/your-feature-name
   ```

3. **Make your changes.** Follow the project conventions:

   - Rust code follows the `rustfmt` style and is checked with `clippy`.
   - TypeScript code follows the Prettier configuration and ESLint rules
     in the repository root.
   - All new code should include appropriate tests.
   - Commit messages should be clear and descriptive.

4. **Sign your commits:**

   ```bash
   git commit -s -m "feat(scope): concise description of change"
   ```

5. **Push your branch** and open a Pull Request against the default branch.

6. **Ensure CI passes.** All checks (lint, typecheck, tests) must pass
   before a PR can be merged.

7. **Address review feedback.** Maintainers may request changes. Please
   engage constructively.

### Pull Request Guidelines

- Each PR should address a single concern. If you have multiple unrelated
  changes, open separate PRs.
- Provide a clear description of what the PR changes and why.
- Reference any related issues.
- Verify that your changes do not introduce regressions by running the
  test suite locally.

## Development Workflow

### Prerequisites

BalanceFrame uses Nix Flakes as its canonical development environment:

```bash
nix develop
```

This provides all required tooling: Rust toolchain, Node.js, pnpm, linters,
and native build dependencies. Do not rely on ambient system packages.

If you are not using Nix, please match the versions specified in
`nix/tooling.nix` and `flake.lock` as closely as possible.

### Common Commands

```bash
# Build all Rust crates
cargo build

# Run Rust tests
cargo test

# Install TypeScript dependencies
pnpm install

# Build all packages
pnpm build

# Run all tests
pnpm test

# Lint and typecheck
pnpm lint
pnpm typecheck

# Run a full Nix flake check
nix flake check
```

### Project Structure

- `crates/` — Rust financial core and protocol definitions
- `packages/` — TypeScript packages (N-API binding, inference, workflow)
- `apps/` — Application shells (CLI, web, server)
- `tests/` — Integration and scenario tests
- `protocol/` — Cross-language protocol schemas and fixtures
- `docs/roadmap/` — Phase-by-phase implementation roadmap

The architecture is a Rust–TypeScript modular monolith. Rust owns financial
validation, checked money calculations, and deterministic analysis.
TypeScript owns Actual integration, workflow state, UI, CLI, and
orchestration. See the [roadmap overview](docs/roadmap/overview.md) for
detailed architecture guidance.

### Testing

- Unit tests accompany the code they test.
- Integration tests live in `tests/` and may require an Actual Budget
  instance or fixture data.
- Protocol-level contract tests validate cross-language schemas.

## Reporting Issues

Please file bugs and feature requests in the GitHub issue tracker. For
security vulnerabilities, see [SECURITY.md](.github/SECURITY.md) instead
of filing a public issue.

## Licensing

By contributing to BalanceFrame, you agree that your contributions will be
licensed under the Apache License, Version 2.0. See the [LICENSE](LICENSE)
file for the full license text.
