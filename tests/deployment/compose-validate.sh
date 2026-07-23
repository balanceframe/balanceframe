#!/usr/bin/env bash
# =============================================================================
# Compose manifest validation tests
# =============================================================================
# Validates compose.yaml and compose.actual.yaml structure and environment
# constraints for release.
# =============================================================================
set -euo pipefail

COMPOSE=${1:-compose.yaml}
OVERLAY=${2:-compose.actual.yaml}

pass=0
fail=0

ok()   { pass=$((pass+1)); echo "  PASS: $*"; }
fail() { fail=$((fail+1)); echo "  FAIL: $*"; }

# -----------------------------------------------------------------------
# Test: canonical compose has only balanceframe service
# -----------------------------------------------------------------------
echo "=== Test: canonical compose structure ==="

# Render the compose config (expands variables with defaults)
rendered="$(docker compose -f "$COMPOSE" config 2>/dev/null)" || {
  fail "docker compose config failed for $COMPOSE"
  echo "$rendered"
  exit 1
}

# Check only balanceframe service
if echo "$rendered" | grep -q 'balanceframe:'; then
  ok "balanceframe service present"
else
  fail "balanceframe service missing"
fi

# Check no actual service in canonical
if echo "$rendered" | grep -q 'actual:'; then
  fail "actual service should NOT be in canonical compose"
else
  ok "no actual service in canonical compose"
fi

# Check single volume
vol_count="$(echo "$rendered" | grep -c 'balanceframe-data:')" || true
if [[ "$vol_count" -ge 1 ]]; then
  ok "balanceframe-data volume declared"
else
  fail "balanceframe-data volume missing"
fi

# Check no dev-only env vars in the rendered config
for var in NUXT_DEV_BYPASS_AUTH BALANCEFRAME_DEV_BYPASS_AUTH NUXT_REVIEW_AND_APPLY BALANCEFRAME_SEED_ALLOWED; do
  if echo "$rendered" | grep -q "$var"; then
    fail "forbidden env var $var found in rendered config"
  else
    ok "forbidden env var $var absent from rendered config"
  fi
done

# -----------------------------------------------------------------------
# Test: combined rendering with overlay
# -----------------------------------------------------------------------
echo "=== Test: combined compose with overlay ==="

combined="$(docker compose -f "$COMPOSE" -f "$OVERLAY" config 2>/dev/null)" || {
  fail "docker compose config failed for combined files"
  exit 1
}

if echo "$combined" | grep -q 'actual:'; then
  ok "actual service present in combined config"
else
  fail "actual service missing from combined config"
fi

# Check distinct volumes
if echo "$combined" | grep -q 'balanceframe-data:'; then
  ok "balanceframe-data volume in combined config"
else
  fail "balanceframe-data volume missing from combined config"
fi
if echo "$combined" | grep -q 'actual-data:'; then
  ok "actual-data volume in combined config"
else
  fail "actual-data volume missing from combined config"
fi

# Check no shared volumes
shared="$(echo "$combined" | grep -A1 'volumes:' | grep -v 'volumes:' | grep -v 'balanceframe-data' | grep -v 'actual-data' || true)"
if [[ -z "$shared" ]]; then
  ok "no shared/missing volumes in combined config"
else
  fail "unexpected volumes: $shared"
fi

# -----------------------------------------------------------------------
# Summary
# -----------------------------------------------------------------------
total=$((pass+fail))
echo "----------------------------------------"
echo "Results: $pass passed, $fail failed (of $total)"
if [[ $fail -gt 0 ]]; then
  exit 1
fi
