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

# Verify that TAG matches the root package.json version (with 'v' prefix)
# and that the tag has not already been released.
# Exits nonzero on mismatch or if the tag already exists on the remote.
release-verify TAG:
    #!/usr/bin/env bash
    set -euo pipefail
    version="$(jq -r '.version' package.json)"
    expected="v${version}"
    ref="{{TAG}}"
    # Strip pre-release suffix for semantic comparison.
    base="${ref%%-*}"
    if [[ "$base" != "$expected" ]]; then
      echo "ERROR: TAG '{{TAG}}' does not match package.json version 'v$version'" >&2
      exit 1
    fi
    echo "OK: TAG '{{TAG}}' matches package.json version 'v$version'"

    # Check that the tag does not already exist on the remote.
    if git ls-remote --tags origin "refs/tags/{{TAG}}" | grep -q .; then
      echo "ERROR: Tag '{{TAG}}' already exists on the remote." >&2
      exit 1
    fi
    echo "OK: Tag '{{TAG}}' has not been released yet."
release-assets TAG DIGEST:
    scripts/release-assets.sh "{{TAG}}" "{{DIGEST}}"

# Run code coverage for JavaScript/TypeScript and Rust, producing separate reports.
# Fails if either language's coverage run fails.
coverage:
    #!/usr/bin/env bash
    set -euo pipefail

    COV_DIR="coverage"
    rm -rf "$COV_DIR"
    mkdir -p "$COV_DIR/js" "$COV_DIR/rust"

    echo "=== JS/TS coverage ==="
    pnpm -r coverage

    echo "=== Rust coverage ==="
    LLVM_COV=llvm-cov LLVM_PROFDATA=llvm-profdata cargo llvm-cov --workspace --all-features --lcov --output-path "$COV_DIR/rust/lcov.info"

    echo "=== Writing coverage summary ==="
    JS_REPORTS="{}"
    if ls "$COV_DIR/js/"*/ >/dev/null 2>&1; then
      for d in "$COV_DIR/js/"*/; do
        pkg="$(basename "$d")"
        JS_REPORTS=$(jq -n \
          --argjson acc "$JS_REPORTS" \
          --arg pkg "$pkg" \
          --arg lcov "$COV_DIR/js/$pkg/lcov.info" \
          --arg json "$COV_DIR/js/$pkg/coverage-final.json" \
          '$acc + {($pkg): {lcov: $lcov, json: $json}}')
      done
    fi

    RUST_REPORT=null
    if [[ -f "$COV_DIR/rust/lcov.info" ]]; then
      RUST_REPORT=$(jq -n --arg lcov "$COV_DIR/rust/lcov.info" '{lcov: $lcov}')
    fi

    jq -n \
      --argjson js "$JS_REPORTS" \
      --argjson rust "$RUST_REPORT" \
      '{
        js: $js,
        rust: $rust,
        note: "JS and Rust coverage percentages apply to disjoint codebases and are not directly comparable."
      }' > "$COV_DIR/summary.json"

    echo ""
    echo "Coverage reports:"
    echo "  JS/TS:  $COV_DIR/js/<pkg>/lcov.info"
    echo "  Rust:   $COV_DIR/rust/lcov.info"
    echo "  Summary:$COV_DIR/summary.json"
    echo ""
    cat "$COV_DIR/summary.json"
