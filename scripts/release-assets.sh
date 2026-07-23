#!/usr/bin/env bash
# =============================================================================
# release-assets — render BalanceFrame release Compose manifests, env example,
# and checksums into _release/<TAG>/
# =============================================================================
# Usage: release-assets TAG DIGEST
#   TAG     — release tag, e.g. v0.1.0
#   DIGEST  — pushed OCI digest, e.g. sha256:<64-hex>
# =============================================================================
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <TAG> <DIGEST>" >&2
  exit 1
fi

TAG="$1"
DIGEST="$2"

out="_release/${TAG}"
mkdir -p "$out"

# Resolve owner from git remote or default to 'balanceframe'
owner="$(git remote get-url origin 2>/dev/null | sed -n 's|.*github.com[/:]\([^/]*\)/.*|\1|p' || echo "balanceframe")"
image_ref="ghcr.io/${owner}/balanceframe@${DIGEST}"

# ---------------------------------------------------------------------------
# compose.yaml
# ---------------------------------------------------------------------------
cat > "$out/compose.yaml" <<'COMPOSE'
# =============================================================================
# BalanceFrame — canonical Docker Compose deployment
# =============================================================================
# This manifest deploys BalanceFrame as a sidecar to an existing Actual Budget
# server.  Actual remains independently usable, upgradeable, and removable.
#
# Usage:
#   cp .env.example .env
#   docker compose up -d
#
# See docs/releases.md for the SemVer and upgrade policy.
# =============================================================================

services:
  balanceframe:
    image: IMAGE_REF_PLACEHOLDER  # vTAG_PLACEHOLDER
    restart: unless-stopped
    ports:
      - "${BALANCEFRAME_PORT:-3030}:3000"
    volumes:
      - balanceframe-data:/data
    environment:
      - NUXT_AUTH_DB_PATH=/data/auth.db
      - BALANCEFRAME_WORKFLOW_DB_PATH=/data/workflow.db
      - BETTER_AUTH_SECRET=${BETTER_AUTH_SECRET}
      - BETTER_AUTH_URL=${BETTER_AUTH_URL:-http://localhost:3030}
    healthcheck:
      test: ["CMD", "wget", "--no-verbose", "--tries=1", "--spider", "http://localhost:3000/api/health"]
      interval: 30s
      timeout: 10s
      retries: 3
      start_period: 30s

volumes:
  balanceframe-data:
COMPOSE

sed -i "s|IMAGE_REF_PLACEHOLDER|${image_ref}|; s|vTAG_PLACEHOLDER|${TAG}|" "$out/compose.yaml"

# ---------------------------------------------------------------------------
# compose.actual.yaml (overlay)
# ---------------------------------------------------------------------------
cat > "$out/compose.actual.yaml" <<'OVERLAY'
# =============================================================================
# BalanceFrame + Actual Budget — optional Docker Compose overlay
# =============================================================================
# This overlay adds an Actual Budget server alongside BalanceFrame.
# Use for a single-host evaluation or a new deployment without an Actual server.
#
# Usage:
#   docker compose -f compose.yaml -f compose.actual.yaml up -d
# =============================================================================

services:
  actual:
    image: actualbudget/actual-server:${ACTUAL_IMAGE_TAG:-latest}
    restart: unless-stopped
    ports:
      - "${ACTUAL_PORT:-5006}:5006"
    volumes:
      - actual-data:/data

volumes:
  actual-data:

networks:
  default:
    name: balanceframe
OVERLAY

# ---------------------------------------------------------------------------
# .env.example
# ---------------------------------------------------------------------------
cat > "$out/.env.example" <<'ENV'
# BalanceFrame — production environment configuration
#
# Copy this file to .env and fill in your values before running Docker Compose.
#   cp .env.example .env && docker compose up -d

# Immutable image reference (set via release assets).
BALANCEFRAME_PORT=3030

# Authentication secret — generate with: openssl rand -hex 32
BETTER_AUTH_SECRET=change-me-to-a-random-secret
BETTER_AUTH_URL=http://localhost:3030
ENV

# ---------------------------------------------------------------------------
# Checksums
# ---------------------------------------------------------------------------
cd "$out"
for f in compose.yaml compose.actual.yaml .env.example; do
  sha256sum "$f" > "$f.sha256"
done
sha256sum compose.yaml compose.actual.yaml .env.example > CHECKSUMS

echo "Release assets written to $out/"
cat CHECKSUMS
