set shell := ["bash", "-euo", "pipefail", "-c"]

# Show the available development commands.
default:
    @just --list

# Configure the repository's shared DCO commit hooks.
setup-hooks:
    git config core.hooksPath .githooks

# Install the locked workspace dependencies.
install:
    pnpm install --frozen-lockfile

# Build all buildable workspace packages.
build:
    pnpm build

# Run TypeScript type checking.
typecheck:
    pnpm typecheck

# Run ESLint with zero warnings allowed.
lint:
    pnpm lint

# Run all JavaScript/TypeScript workspace tests.
test-js:
    pnpm test

# Run all Rust tests.
test-rust:
    cargo test --workspace

# Run the complete project test suite.
test: test-js test-rust

# Run Rust formatting checks.
fmt-rust:
    cargo fmt --all -- --check

# Run Nix formatting checks.
fmt-nix:
    nixfmt --check flake.nix nix/*.nix

# Run all formatting checks.
fmt: fmt-rust fmt-nix

# Run Rust clippy with warnings denied.
clippy:
    cargo clippy --workspace --all-targets -- -D warnings

# Run the local CI-equivalent checks.
ci: install build typecheck lint test clippy
