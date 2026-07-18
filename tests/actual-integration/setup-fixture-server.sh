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

  # Node.js is required for the Actual server
  if ! command -v node &>/dev/null; then
    error "Node.js is required but not found in PATH"
    exit 1
  fi
  ok "Node.js $(node --version)"

  # npx for running @actual-app/api commands
  if ! command -v npx &>/dev/null; then
    error "npx is required but not found in PATH"
    exit 1
  fi
  ok "npx available"

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

# ---- Step 2: Stop any running Actual instances -----------------------------
stop_actual_server() {
  info "Checking for running Actual server instances..."

  # Try to stop any process on the target port
  local pid
  pid=$(lsof -ti "tcp:${ACTUAL_SERVER_PORT}" 2>/dev/null || true)
  if [ -n "$pid" ]; then
    info "Stopping existing Actual server (PID $pid) on port $ACTUAL_SERVER_PORT..."
    run_or_dry kill "$pid" 2>/dev/null || true
    # Wait for it to be fully down
    for i in $(seq 1 10); do
      if ! lsof -ti "tcp:${ACTUAL_SERVER_PORT}" &>/dev/null; then
        ok "Existing server stopped"
        break
      fi
      sleep 0.5
    done
    if lsof -ti "tcp:${ACTUAL_SERVER_PORT}" &>/dev/null; then
      error "Could not stop existing server on port $ACTUAL_SERVER_PORT"
      run_or_dry kill -9 "$pid" 2>/dev/null || true
    fi
  else
    info "No running server found on port $ACTUAL_SERVER_PORT"
  fi
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

start_actual_server() {
  info "Starting Actual server..."

  if [ "$DRY_RUN" = "1" ]; then
    info "[DRY_RUN] Would start Actual server on port $ACTUAL_SERVER_PORT"
    info "[DRY_RUN]   with data directory: $FIXTURE_DIR/server-data"
    return
  fi

  # Create server data directory
  mkdir -p "$SERVER_CACHE_DIR"

  # Start Actual in server mode using npx
  # The Actual server listens on the specified port and manages budget data
  npx -y @actual-app/api serve \
    --port "$ACTUAL_SERVER_PORT" \
    --password "$ACTUAL_SECRET_KEY" \
    --data-dir "$SERVER_CACHE_DIR" &
  local server_pid=$!
  echo "$server_pid" > "$SERVER_PID_FILE"

  # Wait for server to be ready
  info "Waiting for server to become ready..."
  for i in $(seq 1 30); do
    if curl -s "${ACTUAL_SERVER_URL}/health" >/dev/null 2>&1; then
      ok "Actual server is ready at $ACTUAL_SERVER_URL (PID $server_pid)"
      return 0
    fi
    sleep 1
  done

  error "Server did not become ready within 30 seconds"
  kill "$server_pid" 2>/dev/null || true
  return 1
}

# ---- Step 5: Create and seed the test budget --------------------------------
SEED_SCRIPT="$SCRIPT_DIR/.seed-budget.mjs"

create_seed_script() {
  info "Creating seed script..."

  cat > "$SEED_SCRIPT" << 'SEED'
import actualApi from '@actual-app/api';
import { readFileSync } from 'fs';

async function main() {
  const serverUrl = process.env.ACTUAL_SERVER_URL;
  const password = process.env.ACTUAL_SECRET_KEY;
  const budgetName = process.env.ACTUAL_BUDGET_NAME;
  const fixturePath = process.env.FIXTURE_DATA_PATH;

  // Initialize connection
  await actualApi.init({
    serverURL: serverUrl,
    password: password,
    dataDir: '/tmp/balanceframe-seed-data',
  });

  // List existing budgets
  const budgets = await actualApi.getBudgets();
  console.log(JSON.stringify({ status: 'budgets_found', count: budgets.length }));

  // Create and open a new budget
  const { id: budgetId, groupId } = await actualApi.createBudget({
    name: budgetName,
    avoidUpload: false,
  });
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
      const { id: groupId } = await actualApi.createCategoryGroup({ name: group.name });
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

  console.log(JSON.stringify({
    status: 'seeded',
    budgetId,
    groupId,
    serverUrl: process.env.ACTUAL_SERVER_URL,
    budgetName,
  }));

  await actualApi.shutdown();
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

  # Run the seed script
  ACTUAL_SERVER_URL="$ACTUAL_SERVER_URL" \
  ACTUAL_SECRET_KEY="$ACTUAL_SECRET_KEY" \
  ACTUAL_BUDGET_NAME="$ACTUAL_BUDGET_NAME" \
  FIXTURE_DATA_PATH="$FIXTURE_DATA_FILE" \
  node "$SEED_SCRIPT"

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

  # Extract budget info from the seed script's output
  local seed_output
  seed_output=$(node "$SEED_SCRIPT" 2>&1 | tail -1)
  local budget_id
  budget_id=$(echo "$seed_output" | jq -r '.budgetId // empty' 2>/dev/null || echo "")
  local group_id
  group_id=$(echo "$seed_output" | jq -r '.groupId // empty' 2>/dev/null || echo "")

  if [ -z "$budget_id" ] || [ -z "$group_id" ]; then
    error "Could not extract budget/group ID from seed output"
    return 1
  fi

  # Write environment file for tests
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
