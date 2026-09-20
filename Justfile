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

# Verify workspace package links and the native addon consumer path.
link: install
    pnpm --filter @balanceframe/application exec node -e "const native = require('@balanceframe/native'); if (typeof native.analyzeDeterministic !== 'function') process.exit(1);"
# Build all buildable workspace packages.
build:
    pnpm build

# Run TypeScript type checking.
typecheck:
    pnpm typecheck

# Run ESLint with zero warnings allowed.
lint:
    pnpm lint

# Run all JavaScript/TypeScript workspace tests serially because the Actual
# integration client and native SQLite bindings use process-global state.
test-js:
    pnpm -r --workspace-concurrency=1 test

# Run all Rust tests.
test-rust:
    cargo test --workspace

# Run the complete project test suite.
test: test-js test-rust

# Start a local Actual fixture server and seed a test budget.
# Run 'source tests/actual-integration/.env.test' afterwards to pick up connection vars.
setup-fixture:
    cd tests/actual-integration && ./setup-fixture-server.sh

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

# Build the production Docker image for testing.
docker-build:
    docker build -t balanceframe:test .

# Run container integration tests against a built image.
# Requires Docker and a previously built image (just docker-build).
docker-test:
    tests/deployment/container.test.sh

# Validate Compose manifest structure and constraints.
# Requires Docker Compose.
compose-validate:
    tests/deployment/compose-validate.sh

# Verify that TAG matches the root package.json version (with 'v' prefix).
# Locally, reject an already-pushed tag. In GitHub Actions, verify that the
# triggering annotated tag resolves to the checked-out commit.
# Exits nonzero on a version mismatch, reused tag, or mismatched CI tag commit.
release-verify:
    #!/usr/bin/env bash
    set -euo pipefail
    version="$(jq -r '.version' package.json)"
    expected="v${version}"
    ref="${RELEASE_TAG:?RELEASE_TAG is required}"
    # Strip pre-release suffix for semantic comparison.
    base="${ref%%-*}"
    if [[ "$base" != "$expected" ]]; then
      echo "ERROR: TAG '$ref' does not match package.json version 'v$version'" >&2
      exit 1
    fi
    echo "OK: TAG '$ref' matches package.json version 'v$version'"

    if [[ "${GITHUB_ACTIONS:-}" == "true" ]]; then
      tag_commit="$(git ls-remote --tags origin "refs/tags/$ref^{}" | awk '{print $1}')"
      if [[ -z "$tag_commit" || "$tag_commit" != "${GITHUB_SHA:-}" ]]; then
        echo "ERROR: Annotated tag '$ref' does not resolve to the CI commit." >&2
        exit 1
      fi
      echo "OK: Tag '$ref' resolves to the CI commit."
    elif git ls-remote --tags origin "refs/tags/$ref" | grep -q .; then
      echo "ERROR: Tag '$ref' already exists on the remote." >&2
      exit 1
    else
      echo "OK: Tag '$ref' has not been released yet."
    fi
release-assets:
    #!/usr/bin/env bash
    set -euo pipefail
    : "${TAG:?TAG is required}"
    : "${DIGEST:?DIGEST is required}"
    scripts/release-assets.sh "$TAG" "$DIGEST"

# Produce source reports and enforce package, changed-file and workspace gates.
# Local default HEAD includes working-tree and untracked source changes.
# CI: just coverage <pull-request-base-sha> (requires fetched base history).
coverage base="HEAD":
    bash scripts/coverage/run.sh "{{base}}"
