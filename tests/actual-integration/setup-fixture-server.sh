#!/usr/bin/env bash
# =============================================================================
# setup-fixture-server.sh — Actual Budget Integration Test Fixture Setup
# =============================================================================
#
# Creates a fresh disposable Actual Budget server instance for integration tests.
#
# Usage:
#   ./setup-fixture-server.sh                          # Normal mode
#   DRY_RUN=1 ./setup-fixture-server.sh                 # Preview without changes
#   ACTUAL_SERVER_PORT=5006 ./setup-fixture-server.sh   # Custom port
#
# Required environment (set by script or provided externally):
#   ACTUAL_SERVER_URL    — URL of the Actual server (or will be set by script)
#   ACTUAL_SECRET_KEY    — server secret/password
#   ACTUAL_BUDGET_NAME   — name for the test budget (default: "BalanceFrame Test Budget")
#
# Output (on success):
#   Exports ACTUAL_SERVER_URL, ACTUAL_SECRET_KEY, ACTUAL_BUDGET_ID,
#   ACTUAL_GROUP_ID, ACTUAL_BUDGET_NAME as a sourced env snippet
#
# Returns:
#   0 — success, fixture ready
#   1 — failure
# =============================================================================

set -euo pipefail

# ---- Config ----------------------------------------------------------------
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

# Defaults
ACTUAL_SERVER_PORT="${ACTUAL_SERVER_PORT:-5006}"
ACTUAL_SERVER_URL="${ACTUAL_SERVER_URL:-"http://localhost:${ACTUAL_SERVER_PORT}"}"
ACTUAL_SECRET_KEY="${ACTUAL_SECRET_KEY:-"balanceframe-test-secret-key"}"
ACTUAL_BUDGET_NAME="${ACTUAL_BUDGET_NAME:-"BalanceFrame Test Budget"}"

DRY_RUN="${DRY_RUN:-0}"

# ---- Helpers ---------------------------------------------------------------
info()  { printf "\033[36m[INFO]\033[0m %s\n" "$*"; }
warn()  { printf "\033[33m[WARN]\033[0m %s\n" "$*"; }
error() { printf "\033[31m[ERROR]\033[0m %s\n" "$*" >&2; }
ok()    { printf "\033[32m[OK]\033[0m   %s\n" "$*"; }

run_or_dry() {
  if [ "$DRY_RUN" = "1" ]; then
    info "[DRY_RUN] Would execute: $*"
    return 0
  fi
  "$@"
}

cleanup_on_fail() {
  warn "Fixture setup failed — cleaning up..."
  stop_actual_server
  exit 1
}

trap cleanup_on_fail ERR

# ---- Step 1: Check dependencies --------------------------------------------
check_deps() {
  info "Checking dependencies..."

  # The API client is used by the seed script; the server is provided by Nix.
  if ! command -v actual-server &>/dev/null; then
    error "actual-server is required; enter nix develop or provide a compatible server"
    exit 1
  fi
  ok "actual-server $(actual-server --version 2>/dev/null || true)"

  # Node.js is required by the Actual API seed script
  if ! command -v node &>/dev/null; then
    error "Node.js is required but not found in PATH"
    exit 1
  fi
  ok "Node.js $(node --version)"

  # pnpm provides the workspace dependency resolution for the seed script
  if ! command -v pnpm &>/dev/null; then
    error "pnpm is required but not found in PATH"
    exit 1
  fi
  ok "pnpm available"

  # curl for API health checks
  if ! command -v curl &>/dev/null; then
    error "curl is required but not found in PATH"
    exit 1
  fi
  ok "curl available"

  # jq for JSON parsing
  if ! command -v jq &>/dev/null; then
    warn "jq not found — will use node for JSON parsing"
  else
    ok "jq available"
  fi
}

# ---- Step 2: Stop a fixture server previously started by this script --------
stop_actual_server() {
  info "Checking for a fixture server previously started by this script..."

  local pid=""
  if [ -f "$SERVER_PID_FILE" ]; then
    pid="$(cat "$SERVER_PID_FILE")"
  fi

  if [ -z "$pid" ]; then
    local port_pid
    port_pid=$(lsof -ti "tcp:${ACTUAL_SERVER_PORT}" 2>/dev/null || true)
    if [ -n "$port_pid" ]; then
      warn "Port $ACTUAL_SERVER_PORT is occupied by unmanaged PID $port_pid."
      warn "Refusing to stop an existing server without $SERVER_PID_FILE."
      if [ "$DRY_RUN" = "1" ]; then
        return 0
      fi
      error "Choose another ACTUAL_SERVER_PORT or stop the existing server explicitly."
      return 1
    fi
    info "No managed fixture server found."
    return 0
  fi

  if ! kill -0 "$pid" 2>/dev/null; then
    warn "Removing stale fixture PID file for PID $pid."
    rm -f "$SERVER_PID_FILE"
    return 0
  fi

  local command_line
  command_line=$(ps -p "$pid" -o args= 2>/dev/null || true)
  if [[ "$command_line" != *actual-server* ]]; then
    error "PID file $SERVER_PID_FILE points to non-Actual process (PID $pid)."
    return 1
  fi

  info "Stopping managed Actual server (PID $pid) on port $ACTUAL_SERVER_PORT..."
  if [ "$DRY_RUN" = "1" ]; then
    info "[DRY_RUN] Would execute: kill $pid"
    return 0
  fi

  kill "$pid" 2>/dev/null || true
  for _ in $(seq 1 10); do
    if ! kill -0 "$pid" 2>/dev/null; then
      rm -f "$SERVER_PID_FILE"
      ok "Managed fixture server stopped"
      return 0
    fi
    sleep 0.5
  done

  warn "Managed server did not stop gracefully; sending SIGKILL."
  kill -9 "$pid" 2>/dev/null || true
  rm -f "$SERVER_PID_FILE"
}

# ---- Step 3: Create fixture data directory ---------------------------------
FIXTURE_DIR="$SCRIPT_DIR/../../protocol/fixtures"
FIXTURE_DATA_FILE="$FIXTURE_DIR/representative.json"

ensure_fixture_data() {
  info "Ensuring fixture data exists..."

  if [ ! -f "$FIXTURE_DATA_FILE" ]; then
    warn "Fixture data file not found at $FIXTURE_DATA_FILE"
    info "Creating minimal representative fixture data..."

    if [ "$DRY_RUN" = "1" ]; then
      info "[DRY_RUN] Would create $FIXTURE_DATA_FILE"
      return
    fi

    mkdir -p "$FIXTURE_DIR"

    # Generate representative fixture data with sample accounts, categories, payees, and transactions
    cat > "$FIXTURE_DATA_FILE" << 'FIXX'
{
  "metadata": {
    "name": "BalanceFrame Representative Fixture",
    "version": "1.0.0",
    "description": "Representative test fixture for BalanceFrame integration tests"
  },
  "accounts": [
    { "name": "Checking", "type": "checking", "offbudget": false, "closed": false },
    { "name": "Savings", "type": "savings", "offbudget": false, "closed": false },
    { "name": "Credit Card", "type": "credit", "offbudget": true, "closed": false },
    { "name": "Cash", "type": "other", "offbudget": true, "closed": false }
  ],
  "categoryGroups": [
    {
      "name": "Fixed Expenses",
      "categories": [
        { "name": "Rent", "isIncome": false, "hidden": false },
        { "name": "Utilities", "isIncome": false, "hidden": false },
        { "name": "Insurance", "isIncome": false, "hidden": false }
      ]
    },
    {
      "name": "Variable Expenses",
      "categories": [
        { "name": "Groceries", "isIncome": false, "hidden": false },
        { "name": "Dining Out", "isIncome": false, "hidden": false },
        { "name": "Entertainment", "isIncome": false, "hidden": false },
        { "name": "Transportation", "isIncome": false, "hidden": false }
      ]
    },
    {
      "name": "Income",
      "categories": [
        { "name": "Salary", "isIncome": true, "hidden": false },
        { "name": "Freelance", "isIncome": true, "hidden": false }
      ]
    }
  ],
  "payees": [
    { "name": "Acme Corp", "transferAcct": null },
    { "name": "Landlord LLC", "transferAcct": null },
    { "name": "Power Company", "transferAcct": null },
    { "name": "Supermarket Chain", "transferAcct": null },
    { "name": "Online Retailer", "transferAcct": null },
    { "name": "Employer Inc", "transferAcct": null }
  ],
  "transactions": [
    { "account": "Checking", "date": "2025-01-15", "amount": -250000, "payee": "Landlord LLC", "category": "Rent", "notes": "January rent", "cleared": true },
    { "account": "Checking", "date": "2025-01-16", "amount": -8500, "payee": "Power Company", "category": "Utilities", "notes": "Electric bill", "cleared": true },
    { "account": "Checking", "date": "2025-01-17", "amount": -62340, "payee": "Supermarket Chain", "category": "Groceries", "notes": "Weekly groceries", "cleared": true },
    { "account": "Checking", "date": "2025-01-18", "amount": -3500, "payee": "Online Retailer", "category": "Entertainment", "notes": "Subscription", "cleared": true },
    { "account": "Checking", "date": "2025-01-20", "amount": 500000, "payee": "Employer Inc", "category": "Salary", "notes": "Monthly salary", "cleared": true },
    { "account": "Checking", "date": "2025-01-21", "amount": -3200, "payee": "Online Retailer", "category": "Transportation", "notes": "Bus pass", "cleared": false },
    { "account": "Savings", "date": "2025-01-20", "amount": 100000, "payee": "Employer Inc", "category": "Salary", "notes": "Savings transfer", "cleared": true },
    { "account": "Credit Card", "date": "2025-01-22", "amount": -15000, "payee": "Supermarket Chain", "category": "Groceries", "notes": "Credit card groceries", "cleared": true }
  ],
  "rules": [
    { "stage": null, "conditionsOp": "and", "conditions": [{ "field": "payee", "op": "is", "value": "Supermarket Chain" }], "actions": [{ "field": "category", "op": "set", "value": "Groceries" }] }
  ],
  "schedules": [
    { "name": "Monthly Rent", "type": "bill", "amount": -250000, "startDate": "2025-01-01", "frequency": "monthly", "payee": "Landlord LLC" }
  ]
}
FIXX
    ok "Fixture data created at $FIXTURE_DATA_FILE"
  else
    ok "Fixture data found at $FIXTURE_DATA_FILE"
  fi
}

# ---- Step 4: Start Actual server -------------------------------------------
SERVER_CACHE_DIR="$SCRIPT_DIR/.actual-server-data"
SERVER_PID_FILE="$SCRIPT_DIR/.actual-server.pid"
SEED_DATA_DIR="$SERVER_CACHE_DIR/seed-data"
SEED_RESULT_JSON=""

start_actual_server() {
  info "Starting Actual server..."

  if [ "$DRY_RUN" = "1" ]; then
    info "[DRY_RUN] Would start Actual server on port $ACTUAL_SERVER_PORT"
    info "[DRY_RUN]   with data directory: $SERVER_CACHE_DIR"
    return
  fi

  mkdir -p "$SERVER_CACHE_DIR/server-files" "$SERVER_CACHE_DIR/user-files"

  # Actual's published server is a separate executable from @actual-app/api.
  # Configuration is supplied through the documented ACTUAL_* environment
  # variables; the API client password is applied by the seed script.
  ACTUAL_PORT="$ACTUAL_SERVER_PORT" \
  ACTUAL_DATA_DIR="$SERVER_CACHE_DIR" \
  ACTUAL_SERVER_FILES="$SERVER_CACHE_DIR/server-files" \
  ACTUAL_USER_FILES="$SERVER_CACHE_DIR/user-files" \
    actual-server >"$SERVER_CACHE_DIR/server.log" 2>&1 &
  local server_pid=$!
  echo "$server_pid" > "$SERVER_PID_FILE"

  info "Waiting for server to become ready..."
  for i in $(seq 1 30); do
    if curl -s "${ACTUAL_SERVER_URL}/health" >/dev/null 2>&1; then
      ok "Actual server is ready at $ACTUAL_SERVER_URL (PID $server_pid)"
      return 0
    fi
    sleep 1
  done

  error "Server did not become ready within 30 seconds"
  cat "$SERVER_CACHE_DIR/server.log" >&2 || true
  kill "$server_pid" 2>/dev/null || true
  return 1
}

initialize_actual_password() {
  export ACTUAL_SECRET_KEY
  if [ "$DRY_RUN" = "1" ]; then
    info "[DRY_RUN] Would initialize Actual server password"
    return
  fi

  info "Initializing Actual server password..."
  export ACTUAL_PORT="$ACTUAL_SERVER_PORT"
  export ACTUAL_DATA_DIR="$SERVER_CACHE_DIR"
  export ACTUAL_SERVER_FILES="$SERVER_CACHE_DIR/server-files"
  export ACTUAL_USER_FILES="$SERVER_CACHE_DIR/user-files"

  # Reset while the server is stopped so the next process observes the new
  # password instead of retaining the previous account database in memory.
  stop_actual_server
  if ! expect <<'EXPECT'
    set timeout 30
    log_user 0
    spawn actual-server --reset-password
    expect -re "Enter a password, then press enter:" {
      send -- "$env(ACTUAL_SECRET_KEY)"
      after 500
      send -- "\r"
    }
    expect -re "Enter the password again, then press enter:" {
      send -- "$env(ACTUAL_SECRET_KEY)"
      after 500
      send -- "\r"
    }
    expect {
      -re "Password (set|changed)!" {
        expect eof
        exit 0
      }
      -re "Passwords do not match." {
        exit 1
      }
      eof {
        exit 1
      }
    }
EXPECT
  then
    error "Actual server password initialization failed"
    return 1
  fi
  start_actual_server
  ok "Actual server password initialized"
}

# ---- Step 5: Create and seed the test budget --------------------------------
SEED_SCRIPT="$SCRIPT_DIR/.seed-budget.mjs"

create_seed_script() {
  info "Creating seed script..."

  cat > "$SEED_SCRIPT" << 'SEED'
import * as actualApi from '@actual-app/api';
import { readFileSync } from 'fs';

async function main() {
  const serverUrl = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_SECRET_KEY;
  const budgetName = process.env.ACTUAL_BUDGET_NAME;
  const fixturePath = process.env.FIXTURE_DATA_PATH;

  // Initialize connection
  const client = await actualApi.init({
    serverURL: serverUrl,
    password,
    dataDir: process.env.SEED_DATA_DIR,
  });

  await client.send('create-budget', {
    budgetName,
    avoidUpload: false,
  });
  const budgets = await actualApi.getBudgets();
  const budget = budgets.find((candidate) => candidate.name === budgetName);
  if (!budget) {
    throw new Error(`Created budget "${budgetName}" was not returned by the server`);
  }
  const { id: budgetId, groupId } = budget;
  console.log(JSON.stringify({ status: 'budget_created', budgetId, groupId, name: budgetName }));

  // Load fixture data
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  } catch (e) {
    // If no fixture file, create minimal structure
    fixture = { accounts: [], categoryGroups: [], payees: [], transactions: [], rules: [], schedules: [] };
  }

  // Create category groups with categories
  if (fixture.categoryGroups) {
    for (const group of fixture.categoryGroups) {
      const groupId = await actualApi.createCategoryGroup({ name: group.name });
      for (const cat of (group.categories || [])) {
        await actualApi.createCategory({
          name: cat.name,
          groupId: groupId,
          isIncome: cat.isIncome || false,
          hidden: cat.hidden || false,
        });
      }
    }
  }

  // Create accounts
  if (fixture.accounts) {
    for (const acct of fixture.accounts) {
      await actualApi.createAccount({
        name: acct.name,
        type: acct.type,
        offbudget: acct.offbudget || false,
        closed: acct.closed || false,
      });
    }
  }

  // Create payees
  if (fixture.payees) {
    for (const payee of fixture.payees) {
      await actualApi.createPayee({
        name: payee.name,
        transferAcct: payee.transferAcct || null,
      });
    }
  }

  // Get accounts and payees for transaction mapping
  const accounts = await actualApi.getAccounts();
  const payees = await actualApi.getPayees();
  const categories = await actualApi.getCategories();

  const accountMap = {};
  for (const a of accounts) accountMap[a.name] = a.id;
  const payeeMap = {};
  for (const p of payees) payeeMap[p.name] = p.id;
  const categoryMap = {};
  for (const c of categories) categoryMap[c.name] = c.id;

  // Add transactions
  if (fixture.transactions) {
    for (const txnData of fixture.transactions) {
      const acctId = accountMap[txnData.account];
      if (!acctId) continue;

      await actualApi.addTransactions(acctId, [{
        date: txnData.date,
        amount: txnData.amount,
        payee: payeeMap[txnData.payee] || txnData.payee,
        category: categoryMap[txnData.category] || txnData.category,
        notes: txnData.notes || '',
        cleared: txnData.cleared !== false,
      }]);
    }
  }

  // Create rules
  if (fixture.rules) {
    for (const rule of fixture.rules) {
      await actualApi.createRule({
        stage: rule.stage || null,
        conditionsOp: rule.conditionsOp || 'and',
        conditions: rule.conditions || [],
        actions: rule.actions || [],
      });
    }
  }

  // Create schedules
  if (fixture.schedules) {
    for (const schedule of fixture.schedules) {
      await actualApi.createSchedule({
        name: schedule.name,
        type: schedule.type || 'bill',
        amount: schedule.amount || 0,
        startDate: schedule.startDate,
        frequency: schedule.frequency || 'monthly',
        payee: payeeMap[schedule.payee] || schedule.payee,
      });
    }
  }

  // Sync to server
  await actualApi.sync();

  await actualApi.shutdown();
  console.log(JSON.stringify({
    status: 'seeded',
    budgetId,
    groupId,
    serverUrl: process.env.ACTUAL_SERVER_URL,
    budgetName,
  }));
}

main().catch((err) => {
  console.error(JSON.stringify({ status: 'error', message: err.message, stack: err.stack }));
  process.exit(1);
});
SEED
  ok "Seed script created"
}

seed_budget() {
  info "Creating and seeding test budget..."
  info "  Server: $ACTUAL_SERVER_URL"
  info "  Budget: $ACTUAL_BUDGET_NAME"

  if [ "$DRY_RUN" = "1" ]; then
    info "[DRY_RUN] Would seed budget with fixture data from $FIXTURE_DATA_FILE"
    return
  fi

  rm -rf "$SEED_DATA_DIR"
  mkdir -p "$SEED_DATA_DIR"

  local seed_output
  seed_output=$(
    ACTUAL_SERVER_URL="$ACTUAL_SERVER_URL" \
    ACTUAL_SECRET_KEY="$ACTUAL_SECRET_KEY" \
    ACTUAL_BUDGET_NAME="$ACTUAL_BUDGET_NAME" \
    FIXTURE_DATA_PATH="$FIXTURE_DATA_FILE" \
    SEED_DATA_DIR="$SEED_DATA_DIR" \
      node "$SEED_SCRIPT"
  )
  printf '%s\n' "$seed_output"
  SEED_RESULT_JSON="${seed_output##*$'\n'}"

  ok "Budget seeded successfully"
}

# ---- Step 6: Output environment variables ----------------------------------
output_env() {
  info "Generating environment configuration..."

  if [ "$DRY_RUN" = "1" ]; then
    cat << ENV
# === Actual Integration Test Environment (DRY RUN) ===
# The following would be exported:
ACTUAL_SERVER_URL=$ACTUAL_SERVER_URL
ACTUAL_SECRET_KEY=$ACTUAL_SECRET_KEY
ACTUAL_BUDGET_NAME=$ACTUAL_BUDGET_NAME
ENV
    return
  fi

  local seed_output="$SEED_RESULT_JSON"
  local budget_id
  budget_id=$(echo "$seed_output" | jq -r '.budgetId // empty' 2>/dev/null || echo "")
  local group_id
  group_id=$(echo "$seed_output" | jq -r '.groupId // empty' 2>/dev/null || echo "")

  if [ -z "$budget_id" ] || [ -z "$group_id" ]; then
    error "Could not extract budget/group ID from seed output"
    return 1
  fi

  cat > "$SCRIPT_DIR/.env.test" << ENV
ACTUAL_SERVER_URL=$ACTUAL_SERVER_URL
ACTUAL_SECRET_KEY=$ACTUAL_SECRET_KEY
ACTUAL_BUDGET_ID=$budget_id
ACTUAL_GROUP_ID=$group_id
ACTUAL_BUDGET_NAME=$ACTUAL_BUDGET_NAME
ENV

  ok "Environment written to $SCRIPT_DIR/.env.test"
  echo ""
  echo "--- Integration Test Environment ---"
  echo "ACTUAL_SERVER_URL=$ACTUAL_SERVER_URL"
  echo "ACTUAL_SECRET_KEY=$ACTUAL_SECRET_KEY"
  echo "ACTUAL_BUDGET_ID=$budget_id"
  echo "ACTUAL_GROUP_ID=$group_id"
  echo "ACTUAL_BUDGET_NAME=$ACTUAL_BUDGET_NAME"
  echo "-----------------------------------"
}

# ---- Main ------------------------------------------------------------------
main() {
  echo ""
  info "=== BalanceFrame Actual Integration Test Fixture Setup ==="
  echo ""
  info "Mode: $([ "$DRY_RUN" = "1" ] && echo "DRY RUN (preview)" || echo "LIVE")"
  echo ""

  check_deps
  echo ""
  stop_actual_server
  echo ""
  ensure_fixture_data
  echo ""
  start_actual_server
  echo ""
  initialize_actual_password
  echo ""
  create_seed_script
  echo ""
  seed_budget
  echo ""
  output_env

  echo ""
  ok "Fixture setup complete!"
  echo ""
  info "To run tests:  cd tests/actual-integration && ACTUAL_SERVER_URL=$ACTUAL_SERVER_URL ACTUAL_SECRET_KEY=$ACTUAL_SECRET_KEY npx vitest run"
  echo ""
}

main
