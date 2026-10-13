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

if [[ $# -ne 2 ]]; then
  echo "Usage: $0 <TAG> <DIGEST>" >&2
  exit 1
fi

TAG="$1"
DIGEST="$2"

if [[ ! "$TAG" =~ ^v[^/]+[.][^/]+[.][^/]+$ ]] || ! git check-ref-format "refs/tags/${TAG}" >/dev/null 2>&1; then
  echo "Invalid release tag" >&2
  exit 1
fi
if [[ ! "$DIGEST" =~ ^sha256:[0-9a-f]{64}$ ]]; then
  echo "Invalid OCI digest" >&2
  exit 1
fi

out="_release/${TAG}"
mkdir -p _release
if ! mkdir "$out" 2>/dev/null; then
  echo "Release asset output already exists or cannot be created" >&2
  exit 1
fi

# Resolve owner from git remote or default to 'balanceframe'
owner="$(git remote get-url origin 2>/dev/null | sed -n 's|.*github.com[/:]\([^/]*\)/.*|\1|p' || echo "balanceframe")"
image_ref="ghcr.io/${owner}/balanceframe@${DIGEST}"

escape_sed_replacement() {
  sed 's/[&|\\]/\\&/g'
}

escaped_image_ref="$(printf '%s' "$image_ref" | escape_sed_replacement)"
escaped_tag="$(printf '%s' "$TAG" | escape_sed_replacement)"

# Copy the canonical deployment templates and pin the release image.
template_root="$(git rev-parse --show-toplevel 2>/dev/null || (cd "$(dirname "$0")/.." && pwd))"
for file in compose.yaml compose.actual.yaml compose.research.yaml .env.example; do
  cp -- "$template_root/$file" "$out/$file"
done

sed -i 's|${BALANCEFRAME_IMAGE_REF:?required}|IMAGE_REF_PLACEHOLDER  # vTAG_PLACEHOLDER|' "$out/compose.yaml"
sed -i "s|IMAGE_REF_PLACEHOLDER|${escaped_image_ref}|; s|vTAG_PLACEHOLDER|${escaped_tag}|" "$out/compose.yaml"

# ---------------------------------------------------------------------------
# Checksums
# ---------------------------------------------------------------------------
cd "$out"
for f in compose.yaml compose.actual.yaml compose.research.yaml .env.example; do
  sha256sum "$f" > "$f.sha256"
done
sha256sum compose.yaml compose.actual.yaml compose.research.yaml .env.example > CHECKSUMS

echo "Release assets written to $out/"
cat CHECKSUMS
