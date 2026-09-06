#!/usr/bin/env bash
# Usage: just coverage [diff-base]
# Local default HEAD includes staged, unstaged and untracked production sources.
# CI passes the pull-request base SHA (checkout must fetch its history).
# Requires nix develop (Node, pnpm, Actual, cargo-llvm-cov and matching LLVM).
set -euo pipefail
set +m
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT"
BASE="${1:-HEAD}"
if (( $# > 1 )); then echo 'Usage: just coverage [diff-base]' >&2; exit 1; fi
git merge-base HEAD "$BASE" >/dev/null
export LLVM_COV="${LLVM_COV:-llvm-cov}"
export LLVM_PROFDATA="${LLVM_PROFDATA:-llvm-profdata}"
command -v "$LLVM_COV" >/dev/null
command -v "$LLVM_PROFDATA" >/dev/null
command -v actual-server >/dev/null
command -v setsid >/dev/null
command -v gdb >/dev/null

# Refuse concurrent coverage runs; never overwrite the live native addon.
LOCK="$ROOT/.coverage-run.lock"
mkdir -m 700 "$LOCK" || { echo 'Another coverage run owns .coverage-run.lock' >&2; exit 1; }
TEMP=""
FIXTURE_STARTED=0
ENV_SAVED=0
ENV_OWNED=0
ENV_FILE="$ROOT/tests/actual-integration/.env.test"
ACTIVE_PID=""
run_child() {
  # A separate owned process group includes pnpm/Node grandchildren. An async
  # wait is interruptible by Bash traps, unlike a synchronous foreground command.
  setsid --wait "$@" &
  ACTIVE_PID=$!
  local status=0
  wait "$ACTIVE_PID" || status=$?
  if (( status == 0 )); then ACTIVE_PID=""; fi
  return "$status"
}
cleanup() {
  local status=$?
  trap - EXIT
  trap '' INT TERM
  # Always attempt environment restoration, even if a server exits during kill.
  set +e
  if [[ -n "$ACTIVE_PID" ]]; then
    kill -TERM -- "-$ACTIVE_PID" 2>/dev/null
    for _ in {1..10}; do
      kill -0 -- "-$ACTIVE_PID" 2>/dev/null || break
      sleep 0.1
    done
    kill -KILL -- "-$ACTIVE_PID" 2>/dev/null
    wait "$ACTIVE_PID" 2>/dev/null
    ACTIVE_PID=""
  fi
  if [[ "$FIXTURE_STARTED" == 1 && -f "$TEMP/actual/.actual-server.pid" ]]; then
    local pid
    pid="$(cat "$TEMP/actual/.actual-server.pid")"
    if [[ "$pid" =~ ^[0-9]+$ ]] && kill -0 "$pid" 2>/dev/null && [[ "$(ps -p "$pid" -o stat= 2>/dev/null)" != Z* ]]; then
      # A PID alone is not authority: require our unique disposable data path.
      if [[ -r "/proc/$pid/environ" ]] && tr '\0' '\n' <"/proc/$pid/environ" | grep -Fx "ACTUAL_DATA_DIR=$TEMP/actual" >/dev/null; then
        kill "$pid" 2>/dev/null
        for _ in {1..20}; do
          kill -0 "$pid" 2>/dev/null || break
          sleep 0.1
        done
        if kill -0 "$pid" 2>/dev/null; then kill -9 "$pid"; fi
      else
        echo "Refusing to stop unverified fixture PID $pid; preserving $TEMP" >&2
        TEMP=""
        status=1
      fi
    fi
  fi
  if [[ "$ENV_OWNED" == 1 ]]; then
    if [[ "$ENV_SAVED" == 1 ]]; then
      if ! cp -p "$LOCK/env.test" "$ENV_FILE"; then
        echo "Could not restore .env.test; preserving backup in $LOCK" >&2
        LOCK=""
        status=1
      fi
    elif ! rm -f "$ENV_FILE"; then
      status=1
    fi
  fi
  if [[ -n "$TEMP" ]]; then rm -rf "$TEMP" || status=1; fi
  if [[ -n "$LOCK" ]]; then rm -rf "$LOCK" || status=1; fi
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
TEMP="$(mktemp -d "${TMPDIR:-/tmp}/balanceframe-coverage.XXXXXXXX")"
umask 077
# No consumer may inherit a developer's Actual identity/configuration, vault,
# connection file or database paths. Explicit config also bypasses config.json
# auto-discovery in Actual's cwd/package/data directories.
for variable in ${!ACTUAL_@} ${!BALANCEFRAME_@} ${!NUXT_@}; do unset "$variable"; done
mkdir -p "$TEMP/actual" "$TEMP/application"
printf '{}\n' > "$TEMP/actual/config.json"
export ACTUAL_CONFIG_PATH="$TEMP/actual/config.json"
export ACTUAL_SERVER_DATA_DIR="$TEMP/actual"
export ACTUAL_HOSTNAME=127.0.0.1
export BALANCEFRAME_CONFIG_PATH="$TEMP/application/config.json"
export BALANCEFRAME_CREDENTIAL_DIR="$TEMP/application/credentials"
export BALANCEFRAME_WORKFLOW_DB_PATH="$TEMP/application/workflow.db"
export BALANCEFRAME_AUTH_DB_PATH="$TEMP/application/auth.db"
export NUXT_WORKFLOW_DB_PATH="$BALANCEFRAME_WORKFLOW_DB_PATH"
export NUXT_AUTH_DB_PATH="$BALANCEFRAME_AUTH_DB_PATH"
run_child node scripts/coverage/check.mjs --list > "$TEMP/packages.tsv"
rm -rf coverage
mkdir -p coverage/js/coverage-gates coverage/rust coverage/native

# LLVM tools are provided by the development shell, not downloaded by rustup.
# A private target directory keeps existing release artifacts and profiles intact.
export CARGO_TARGET_DIR="$ROOT/coverage/target"
run_child cargo llvm-cov show-env --export-prefix > "$TEMP/llvm-env"
eval "$(cat "$TEMP/llvm-env")"
export CARGO_TARGET_DIR="$CARGO_LLVM_COV_TARGET_DIR"
run_child cargo test --workspace --all-features
run_child pnpm --filter @balanceframe/native exec napi build ../../coverage/native
export BALANCEFRAME_COVERAGE_NATIVE="$ROOT/coverage/native/balanceframe.node"
export BALANCEFRAME_COVERAGE_ORIGINAL="$ROOT/crates/node-binding/balanceframe.node"
export BALANCEFRAME_COVERAGE_LOADS="$ROOT/coverage/native/loads.log"
test -s "$BALANCEFRAME_COVERAGE_NATIVE"
cat >"$TEMP/native-loader.cjs" <<'NODE'
const Module = require('node:module');
const fs = require('node:fs');
const load = Module._extensions['.node'];
const original = fs.realpathSync(process.env.BALANCEFRAME_COVERAGE_ORIGINAL);
Module._extensions['.node'] = (module, filename) => {
  if (fs.realpathSync(filename) === original) {
    fs.appendFileSync(process.env.BALANCEFRAME_COVERAGE_LOADS, `${process.pid}\n`);
    return load(module, process.env.BALANCEFRAME_COVERAGE_NATIVE);
  }
  return load(module, filename);
};
NODE
export NODE_OPTIONS="${NODE_OPTIONS:-} --require=$TEMP/native-loader.cjs"
run_child pnpm --filter @balanceframe/native test
# Exercise the generated registration error path against the real Node/N-API host.
run_child gdb --nx --batch --return-child-result \
  -x crates/node-binding/test/fixtures/registration-failure.gdb \
  --args node crates/node-binding/test/registration-failure.mjs
# Native consumers must actually load the instrumented addon, not just Rust tests.
test -s "$BALANCEFRAME_COVERAGE_LOADS"

# Own a new loopback-only fixture. Ignore caller connection/secret/provenance;
# preserve and restore an existing .env.test used by a developer's fixture.
if [[ -e "$ENV_FILE" ]]; then cp -p "$ENV_FILE" "$LOCK/env.test"; ENV_SAVED=1; fi
ENV_OWNED=1
run_child node -e 'const s=require("node:net").createServer();s.listen(0,"127.0.0.1",()=>{console.log(s.address().port);s.close()})' > "$TEMP/port"
export ACTUAL_SERVER_PORT
ACTUAL_SERVER_PORT="$(cat "$TEMP/port")"
export ACTUAL_SERVER_URL="http://127.0.0.1:$ACTUAL_SERVER_PORT"
export ACTUAL_BUDGET_NAME="BalanceFrame Coverage Fixture"
export DRY_RUN=0
FIXTURE_STARTED=1
run_child bash tests/actual-integration/setup-fixture-server.sh
set -a
source "$ENV_FILE"
set +a

# Mandatory serial execution includes native-backed contracts and live Actual.
# JSON result reports let the checker reject empty/skipped/pending test runs.
while IFS=$'\t' read -r package report; do
  mkdir -p "$ROOT/coverage/$report"
  run_child node scripts/coverage/check.mjs --sources "$package" > "$TEMP/sources"
  coverage_args=()
  while IFS= read -r source; do coverage_args+=("--coverage.include=$source"); done < "$TEMP/sources"
  run_child pnpm --filter "$package" exec vitest run --coverage "${coverage_args[@]}" --reporter=default --reporter=json --outputFile="$ROOT/coverage/$report/tests.json"
done <"$TEMP/packages.tsv"

# Execute the real CLI entrypoint, not a mock or a generated-source substitute.
# Its child-process V8 record replaces Vitest's unimported-file placeholder.
run_child node --experimental-test-coverage --test \
  '--test-coverage-include=**/apps/cli/bin/*.js' \
  --test-reporter=spec --test-reporter=lcov \
  --test-reporter-destination=stdout \
  --test-reporter-destination=coverage/js/cli/entrypoint-lcov.info \
  apps/cli/bin/cli.js

# Node's coverage reporter includes checker subprocess execution from the
# executable behavior suite; its production script gets the same 80% gate.
run_child node --experimental-test-coverage --test \
  '--test-coverage-include=**/scripts/coverage/check.mjs' \
  --test-reporter=spec --test-reporter=lcov \
  --test-reporter-destination=stdout \
  --test-reporter-destination=coverage/js/coverage-gates/lcov.info \
  scripts/coverage/check.test.mjs scripts/coverage/run.test.mjs
run_child cargo llvm-cov report --lcov --output-path coverage/rust/lcov.info \
  --ignore-filename-regex '(^|/)(tests/|fuzz\.rs$|phase_85_tests\.rs$)'
run_child cargo llvm-cov report --json --output-path coverage/rust/coverage.json \
  --ignore-filename-regex '(^|/)(tests/|fuzz\.rs$|phase_85_tests\.rs$)'
run_child node scripts/coverage/check.mjs --base "$BASE" --require-execution
