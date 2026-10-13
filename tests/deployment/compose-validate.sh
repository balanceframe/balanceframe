#!/usr/bin/env bash
set +x
set -euo pipefail
umask 077

COMPOSE=${1:-compose.yaml}
ACTUAL_OVERLAY=${2:-compose.actual.yaml}
RESEARCH_OVERLAY=${3:-compose.research.yaml}

if [[ -n ${COMPOSE_BIN:-} ]]; then
  if [[ ! -x "$COMPOSE_BIN" ]]; then
    echo "FAIL: Compose renderer unavailable"
    exit 1
  fi
  compose=("$COMPOSE_BIN")
else
  compose=(docker compose)
fi

project_dir="$(cd -- "$(dirname -- "$COMPOSE")" 2>/dev/null && pwd -P 2>/dev/null)" || {
  echo "FAIL: Compose project directory unavailable"
  exit 1
}
tmpdir="$(mktemp -d 2>/dev/null)" || {
  echo "FAIL: Compose temporary directory unavailable"
  exit 1
}
trap 'rm -rf -- "$tmpdir"' EXIT
env_file="$tmpdir/sentinels.env"
source_path="$tmpdir/missing/merchant-research.json"
printf '%s\n' \
  'BALANCEFRAME_IMAGE_REF=balanceframe:compose-validation' \
  'BALANCEFRAME_PORT=3030' \
  'ACTUAL_SERVER_URL=http://actual.example.invalid' \
  'ACTUAL_SECRET_KEY=actual-secret-sentinel-private' \
  'BETTER_AUTH_SECRET=auth-secret-sentinel-private' \
  'BETTER_AUTH_URL=http://localhost:3030' \
  "BALANCEFRAME_MERCHANT_CONFIG_FILE=$source_path" \
  'VALUESERP_API_KEY=provider-key-sentinel-private' > "$env_file"

canonical_json="$tmpdir/canonical.json"
actual_json="$tmpdir/actual.json"
research_json="$tmpdir/research.json"
render_failed=0

render() {
  local label=$1
  local output=$2
  shift 2
  if env -i \
    PATH="$PATH" HOME="$tmpdir" TMPDIR="$tmpdir" \
    XDG_CONFIG_HOME="$tmpdir/xdg" DOCKER_CONFIG="$tmpdir/docker" \
    "${compose[@]}" \
      --project-directory "$project_dir" \
      --project-name balanceframe-compose-validation \
      --env-file "$env_file" \
      -f "$COMPOSE" "$@" config --format json \
      > "$output" 2> "$tmpdir/compose-error.log"; then
    echo "PASS: $label Compose JSON rendered"
  else
    echo "FAIL: $label Compose render failed (diagnostics suppressed)"
    render_failed=1
  fi
}

render "canonical" "$canonical_json" || render_failed=1
render "Actual overlay" "$actual_json" -f "$ACTUAL_OVERLAY" || render_failed=1
render "research overlay" "$research_json" -f "$RESEARCH_OVERLAY" || render_failed=1

if [[ "$render_failed" -eq 0 ]]; then
  if env -i PATH="$PATH" HOME="$tmpdir" TMPDIR="$tmpdir" \
    node - "$canonical_json" "$actual_json" "$research_json" "$source_path" <<'NODE'
const fs = require('node:fs');
const [canonicalPath, actualPath, researchPath, sourcePath] = process.argv.slice(2);
let failures = 0;
function check(condition, label) {
  console.log(`${condition ? 'PASS' : 'FAIL'}: ${label}`);
  if (!condition) failures++;
}
function load(path) {
  try { return JSON.parse(fs.readFileSync(path, 'utf8')); }
  catch { return null; }
}
function envOf(service) {
  const environment = service?.environment ?? {};
  if (!Array.isArray(environment)) return environment;
  return Object.fromEntries(environment.map((entry) => {
    const separator = entry.indexOf('=');
    return separator < 0 ? [entry, ''] : [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}
function volumes(service) { return service?.volumes ?? []; }
function hasVolume(config, name) { return Object.hasOwn(config?.volumes ?? {}, name); }

const canonical = load(canonicalPath);
const actual = load(actualPath);
const research = load(researchPath);
check(canonical !== null, 'canonical Compose JSON parsed privately');
check(actual !== null, 'Actual overlay Compose JSON parsed privately');
check(research !== null, 'research overlay Compose JSON parsed privately');

if (canonical) {
  const names = Object.keys(canonical.services ?? {}).sort();
  const service = canonical.services?.balanceframe;
  const environment = envOf(service);
  check(names.length === 1 && names[0] === 'balanceframe', 'canonical deployment has only BalanceFrame');
  check(hasVolume(canonical, 'balanceframe-data') &&
    volumes(service).some((mount) => mount.type === 'volume' && mount.source === 'balanceframe-data' && mount.target === '/data'),
  'canonical data volume remains mounted at /data');
  check(environment.BALANCEFRAME_CONFIG_PATH === '/data/config.json', 'connection configuration remains on the data volume');
  check(!Object.hasOwn(environment, 'VALUESERP_API_KEY') &&
    !Object.hasOwn(environment, 'BALANCEFRAME_MERCHANT_CONFIG_PATH') &&
    !volumes(service).some((mount) => mount.target === '/run/secrets/merchant-research.json'),
  'canonical deployment has no research key, config path, or bind mount');
  const forbidden = ['NUXT_DEV_BYPASS_AUTH', 'BALANCEFRAME_DEV_BYPASS_AUTH', 'NUXT_REVIEW_AND_APPLY', 'BALANCEFRAME_SEED_ALLOWED'];
  check(forbidden.every((key) => !Object.hasOwn(environment, key)), 'canonical deployment excludes development-only environment');
}

if (actual) {
  const actualService = actual.services?.actual;
  const balanceframeMounts = volumes(actual.services?.balanceframe);
  const actualMounts = volumes(actualService);
  check(Boolean(actualService), 'Actual overlay adds the Actual service');
  check(hasVolume(actual, 'balanceframe-data') && hasVolume(actual, 'actual-data') &&
    balanceframeMounts.some((mount) => mount.source === 'balanceframe-data') &&
    actualMounts.some((mount) => mount.source === 'actual-data') &&
    !balanceframeMounts.some((mount) => mount.source === 'actual-data') &&
    !actualMounts.some((mount) => mount.source === 'balanceframe-data'),
  'Actual and BalanceFrame retain distinct data volumes');
}

if (research) {
  const services = research.services ?? {};
  const service = services.balanceframe;
  const environment = envOf(service);
  const mounts = volumes(service).filter((mount) => mount.target === '/run/secrets/merchant-research.json');
  const mount = mounts[0];
  check(Object.keys(services).length === 1 && Boolean(service), 'research overlay only extends BalanceFrame');
  check(environment.BALANCEFRAME_MERCHANT_CONFIG_PATH === '/run/secrets/merchant-research.json' &&
    typeof environment.VALUESERP_API_KEY === 'string' && environment.VALUESERP_API_KEY.length > 0,
  'research overlay sets the fixed config path and required server key');
  check(mounts.length === 1 && mount.type === 'bind' && mount.source === sourcePath &&
    mount.read_only === true && mount.bind?.create_host_path === false,
  'research overlay uses one exact read-only bind and forbids host-path creation');
}

process.exitCode = failures === 0 ? 0 : 1;
NODE
  then
    :
  else
    render_failed=1
  fi
fi

if [[ "$render_failed" -ne 0 || -e "$(dirname -- "$source_path")" ]]; then
  echo "FAIL: offline Compose validation failed (sensitive diagnostics suppressed)"
  exit 1
fi
echo "PASS: missing research config directory was not created"
