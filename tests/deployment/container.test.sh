#!/usr/bin/env bash
# =============================================================================
# Container integration tests — run against the production Docker image.
# =============================================================================
# Usage:
#   cd <repo-root>
#   docker build -t balanceframe:test .
#   tests/deployment/container.test.sh
# =============================================================================
set -euo pipefail

IMAGE=${1:-balanceframe:test}

pass=0
fail=0

ok()   { pass=$((pass+1)); echo "  PASS: $*"; }
fail() { fail=$((fail+1)); echo "  FAIL: $*"; }

check_health() {
  local cid="$1" label="$2"
  local i=0
  while [[ $i -lt 10 ]]; do
    if docker exec "$cid" wget --no-verbose --tries=1 --spider http://localhost:3000/api/health 2>/dev/null; then
      return 0
    fi
    sleep 1
    i=$((i+1))
  done
  return 1
}

# -----------------------------------------------------------------------
# Test 1: healthy start with writable /data
# -----------------------------------------------------------------------
echo "=== Test: healthy start with writable /data ==="
cid="$(docker run -d \
  -e BETTER_AUTH_SECRET=test-secret-not-for-production \
  -e BETTER_AUTH_URL=http://localhost:3030 \
  -v balanceframe-test-data:/data \
  "$IMAGE" 2>/dev/null)" || {
  fail "container failed to start"
  exit 1
}
trap 'docker rm -f "$cid" 2>/dev/null; docker volume rm balanceframe-test-data 2>/dev/null' EXIT

if check_health "$cid" "health"; then
  ok "health endpoint returned 200"
else
  fail "health endpoint unreachable within 10s"
fi

# Check SQLite files
for db in /data/auth.db /data/workflow.db; do
  if docker exec "$cid" test -f "$db"; then
    ok "$db exists"
  else
    fail "$db missing"
  fi
done

# Check no build tools present
for tool in rustc cargo pnpm; do
  if docker exec "$cid" which "$tool" 2>/dev/null; then
    fail "build tool $tool found in runtime image"
  else
    ok "build tool $tool absent"
  fi
done

docker rm -f "$cid" 2>/dev/null
docker volume rm balanceframe-test-data 2>/dev/null
trap '' EXIT

# -----------------------------------------------------------------------
# Test 2: dev-flag rejection (each variable, each value variant)
# -----------------------------------------------------------------------
echo "=== Test: dev-flag rejection ==="
forbidden_vars=(
  NUXT_DEV_BYPASS_AUTH
  BALANCEFRAME_DEV_BYPASS_AUTH
  NUXT_REVIEW_AND_APPLY
  BALANCEFRAME_SEED_ALLOWED
)

for var in "${forbidden_vars[@]}"; do
  for val in true false ""; do
    env_flag=""
    if [[ -n "$val" ]]; then
      env_flag="-e ${var}=${val}"
    else
      env_flag="-e ${var}="
    fi
    # shellcheck disable=SC2086
    cid="$(docker run -d $env_flag \
      -e BETTER_AUTH_SECRET=test-secret \
      -e BETTER_AUTH_URL=http://localhost:3030 \
      "$IMAGE" 2>/dev/null)" || true

    if [[ -n "${cid:-}" ]]; then
      # Container started — wait briefly then check exit status
      sleep 2
      exit_code="$(docker inspect "$cid" --format='{{.State.ExitCode}}' 2>/dev/null || echo "running")"
      docker rm -f "$cid" 2>/dev/null
      if [[ "$exit_code" != "0" && "$exit_code" != "running" ]]; then
        ok "${var}=${val:-empty} correctly rejected (exit=$exit_code)"
      else
        fail "${var}=${val:-empty} should have been rejected"
      fi
    fi
  done
done

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
total=$((pass+fail))
echo "----------------------------------------"
echo "Results: $pass passed, $fail failed (of $total)"
if [[ $fail -gt 0 ]]; then
  exit 1
fi
