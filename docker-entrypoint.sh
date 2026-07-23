#!/usr/bin/env bash
set -euo pipefail

# =============================================================================
# BalanceFrame Docker entrypoint
# =============================================================================
# Guards against development-only configuration in production images and
# initialises the persistent data directory.

FORBIDDEN_VARS=(
  NUXT_DEV_BYPASS_AUTH
  BALANCEFRAME_DEV_BYPASS_AUTH
  NUXT_REVIEW_AND_APPLY
  BALANCEFRAME_SEED_ALLOWED
)

violations=()
for var in "${FORBIDDEN_VARS[@]}"; do
  if [[ -n "${!var:+set}" ]]; then
    violations+=("$var is set (${!var:-<empty>})")
  fi
done

if [[ ${#violations[@]} -gt 0 ]]; then
  echo "ERROR: Development-only environment variable(s) detected in production image." >&2
  echo "  These variables are forbidden in released BalanceFrame images:" >&2
  for v in "${violations[@]}"; do
    echo "  - $v" >&2
  done
  echo "" >&2
  echo "Use the Nix development shell for local development." >&2
  exit 1
fi

# Ensure /data exists and is writable.
data_dir="/data"
if [[ ! -d "$data_dir" ]]; then
  mkdir -p "$data_dir"
fi
if [[ ! -w "$data_dir" ]]; then
  echo "ERROR: Data directory $data_dir is not writable." >&2
  exit 1
fi

# Execute the main container command.
exec "$@"
