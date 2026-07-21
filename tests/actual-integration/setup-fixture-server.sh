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

    # Generate representative fixture data using the canonical protocol shape
    cat > "$FIXTURE_DATA_FILE" << 'FIXX'
{
  "schemaVersion": "1",
  "actualVersion": "25.1.0",
  "snapshotDate": "2026-07-15T00:00:00Z",
  "accounts": [
    { "id": "a_1", "name": "Checking Account", "accountType": "checking", "offBudget": false, "isClosed": false },
    { "id": "a_2", "name": "Savings Account", "accountType": "savings", "offBudget": false, "isClosed": false },
    { "id": "a_3", "name": "Credit Card", "accountType": "creditCard", "offBudget": false, "isClosed": false },
    { "id": "a_4", "name": "Cash Wallet", "accountType": "cash", "offBudget": true, "isClosed": false },
    { "id": "a_5", "name": "Investment Portfolio", "accountType": "investment", "offBudget": true, "isClosed": false },
    { "id": "a_6", "name": "Car Loan", "accountType": "loan", "offBudget": false, "isClosed": false }
  ],
  "categories": [
    { "id": "cat_1", "name": "Rent / Mortgage", "groupName": "Housing", "isIncome": false },
    { "id": "cat_2", "name": "Groceries", "groupName": "Food", "isIncome": false },
    { "id": "cat_3", "name": "Dining Out", "groupName": "Food", "isIncome": false },
    { "id": "cat_4", "name": "Gas / Fuel", "groupName": "Transportation", "isIncome": false },
    { "id": "cat_5", "name": "Public Transit", "groupName": "Transportation", "isIncome": false },
    { "id": "cat_6", "name": "Electric Bill", "groupName": "Utilities", "isIncome": false },
    { "id": "cat_7", "name": "Water Bill", "groupName": "Utilities", "isIncome": false },
    { "id": "cat_8", "name": "Internet", "groupName": "Utilities", "isIncome": false },
    { "id": "cat_9", "name": "Streaming Services", "groupName": "Entertainment", "isIncome": false },
    { "id": "cat_10", "name": "Movie / Events", "groupName": "Entertainment", "isIncome": false },
    { "id": "cat_11", "name": "Pharmacy", "groupName": "Healthcare", "isIncome": false },
    { "id": "cat_12", "name": "Doctor Visit", "groupName": "Healthcare", "isIncome": false },
    { "id": "cat_13", "name": "Emergency Savings", "groupName": "Savings", "isIncome": false },
    { "id": "cat_deleted", "name": "Old Category", "groupName": "Savings", "isIncome": false, "deleted": true },
    { "id": "cat_15", "name": "Business Travel", "groupName": "Transportation", "isIncome": false },
    { "id": "cat_16", "name": "Gifts", "groupName": "Entertainment", "isIncome": false }
  ],
  "payees": [
    { "id": "pay_1", "name": "AMAZON MKTPLACE", "transferAccountId": null },
    { "id": "pay_2", "name": "Amazon Marketplace", "transferAccountId": null },
    { "id": "pay_3", "name": "Whole Foods", "transferAccountId": null },
    { "id": "pay_4", "name": "Shell Gas Station", "transferAccountId": null },
    { "id": "pay_5", "name": "City Electric Co", "transferAccountId": null },
    { "id": "pay_6", "name": "Netflix", "transferAccountId": null },
    { "id": "pay_7", "name": "Spotify", "transferAccountId": null },
    { "id": "pay_8", "name": "Landlord Property Mgmt", "transferAccountId": null },
    { "id": "pay_9", "name": "Starbucks", "transferAccountId": null },
    { "id": "pay_10", "name": "Target", "transferAccountId": null },
    { "id": "pay_11", "name": "CVS Pharmacy", "transferAccountId": null },
    { "id": "pay_12", "name": "Uber", "transferAccountId": null },
    { "id": "pay_13", "name": "Home Depot", "transferAccountId": null },
    { "id": "pay_14", "name": "Costco Wholesale", "transferAccountId": null },
    { "id": "pay_15", "name": "Best Buy", "transferAccountId": null },
    { "id": "pay_16", "name": "ATM Withdrawal", "transferAccountId": null },
    { "id": "pay_17", "name": "Direct Deposit - Employer", "transferAccountId": null },
    { "id": "pay_18", "name": "Checking <> Credit Card", "transferAccountId": "a_3" },
    { "id": "pay_19", "name": "Checking <> Savings", "transferAccountId": "a_2" },
    { "id": "pay_20", "name": "Checking <> Loan", "transferAccountId": "a_6" },
    { "id": "pay_21", "name": "Comcast Cable", "transferAccountId": null },
    { "id": "pay_22", "name": "City Water Dept", "transferAccountId": null }
  ],
  "transactions": [
    { "id": "tx_000", "accountId": "a_1", "date": "2026-07-09", "payeeName": "Whole Foods", "categoryName": "Groceries", "amount": { "minorUnits": "-1500", "currency": "USD" }, "cleared": true, "notes": "Weekly groceries" },
    { "id": "tx_001", "accountId": "a_2", "date": "2026-07-08", "payeeName": "Shell Gas Station", "categoryName": "Gas / Fuel", "amount": { "minorUnits": "-2300", "currency": "USD" }, "cleared": true, "notes": null },
    { "id": "tx_002", "accountId": "a_3", "date": "2026-07-12", "payeeName": "City Electric Co", "categoryName": "Utilities", "amount": { "minorUnits": "-3500", "currency": "USD" }, "cleared": true, "notes": null },
    { "id": "tx_003", "accountId": "a_1", "date": "2026-07-11", "payeeName": "Netflix", "categoryName": "Entertainment", "amount": { "minorUnits": "-4200", "currency": "USD" }, "cleared": true, "notes": null },
    { "id": "tx_004", "accountId": "a_1", "date": "2026-07-15", "payeeName": "Direct Deposit - Employer", "categoryName": null, "amount": { "minorUnits": "500000", "currency": "USD" }, "cleared": true, "notes": "Monthly salary" },
    { "id": "tx_005", "accountId": "a_1", "date": "2026-07-10", "payeeName": "Starbucks", "categoryName": "Dining Out", "amount": { "minorUnits": "-750", "currency": "USD" }, "cleared": true, "notes": null },
    { "id": "tx_006", "accountId": "a_4", "date": "2026-07-14", "payeeName": "ATM Withdrawal", "categoryName": null, "amount": { "minorUnits": "-20000", "currency": "USD" }, "cleared": true, "notes": null },
    { "id": "tx_007", "accountId": "a_1", "date": "2026-07-12", "payeeName": "Checking <> Credit Card", "categoryName": null, "amount": { "minorUnits": "-150000", "currency": "USD" }, "cleared": true, "notes": "Credit card payment" },
    { "id": "tx_008", "accountId": "a_6", "date": "2026-07-15", "payeeName": "Checking <> Loan", "categoryName": null, "amount": { "minorUnits": "-50000", "currency": "USD" }, "cleared": true, "notes": "Loan installment" }
  ],
  "rules": [],
  "schedules": [],
  "budgets": [],
  "tags": []
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

// Map canonical protocol accountType to Actual API account type
function mapAccountType(t) {
  switch (t) {
    case 'checking': return 'checking';
    case 'savings': return 'savings';
    case 'creditCard': return 'credit';
    case 'cash':
    case 'investment':
    case 'loan':
    case 'other': return 'other';
    default: return 'other';
  }
}

// Helper: resolve a category-group ID from createCategoryGroup return value.
// The API may return a string ID directly, or empty — in which case we
// refresh the group list and locate the newly created group by name.
async function resolveGroupId(name, directResult) {
  if (directResult && typeof directResult === 'string' && directResult.length > 0) {
    return directResult;
  }
  // Fallback: look up the group we just created
  const groups = await actualApi.getCategoryGroups();
  const found = groups.find((g) => g.name === name);
  if (!found || !found.id) {
    throw new Error(
      `Actual did not create category group "${name}" `
      + `(createCategoryGroup returned ${JSON.stringify(directResult)}, `
      + `getCategoryGroups returned ${JSON.stringify(groups.map((g) => ({ id: g.id, name: g.name })))})`
    );
  }
  return found.id;
}

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

  // Create budget and resolve identity
  await client.send('create-budget', {
    budgetName,
    avoidUpload: false,
  });
  const budgets = await actualApi.getBudgets();

  // getBudgets() may return separate local and cloud entries for the same budget.
  // Prefer cloudBudget.cloudFileId (the remote listing identifier) first, then
  // cloudBudget.id, then localBudget?.id — because a fresh Actual client exposes
  // the cloud file UUID as cloudFileId when id is absent from the remote response.
  // ActualConnector.discoverBudgets uses cloudFileId as the public identifier,
  // so this ordering matches discoverBudgets for a freshly-seeded setup.
  const localBudget = budgets.find(
    (c) => c.name === budgetName && 'id' in c && Boolean(c.id),
  );
  const cloudBudget = budgets.find(
    (c) => c.name === budgetName && Boolean(c.groupId),
  );
  if (!cloudBudget) {
    throw new Error(
      `Created budget "${budgetName}" was not fully synchronized with the server. Cloud entry missing.`,
    );
  }
  // Resolve the budget ID the same way ActualConnector.discoverBudgets does:
  // cloudFileId ?? id ?? '' — cloudBudget.cloudFileId (remote UUID) takes priority
  // because a fresh setup only has cloudFileId as the true public identifier.
  const resolvedBudgetId =
    cloudBudget.cloudFileId ?? cloudBudget.id ?? localBudget?.id ?? '';
  if (!resolvedBudgetId) {
    throw new Error(
      `Could not resolve a budget ID for "${budgetName}" `
      + `(cloudBudget.id=${JSON.stringify(cloudBudget?.id)}, `
      + `cloudFileId=${JSON.stringify(cloudBudget?.cloudFileId)}, `
      + `localBudget.id=${JSON.stringify(localBudget?.id)})`,
    );
  }
  const groupId = cloudBudget.groupId;

  console.log(JSON.stringify({ status: 'budget_created', budgetId: resolvedBudgetId, groupId, name: budgetName }));

  // Load fixture data
  let fixture;
  try {
    fixture = JSON.parse(readFileSync(fixturePath, 'utf-8'));
  } catch (e) {
    // If no fixture file, create minimal structure
    fixture = {
      accounts: [], categories: [], categoryGroups: [], payees: [],
      transactions: [], rules: [], schedules: [],
    };
  }

  // ---- Categories (canonical flat or legacy grouped) ----
  if (fixture.categories && fixture.categories.length > 0) {
    // Canonical protocol shape: flat categories with groupName field.
    // Group by groupName and create one category group per distinct name.
    const groupByName = {};
    for (const cat of fixture.categories) {
      if (cat.deleted) continue;
      if (!groupByName[cat.groupName]) {
        groupByName[cat.groupName] = await resolveGroupId(
          cat.groupName,
          await actualApi.createCategoryGroup({ name: cat.groupName }),
        );
      }
      // Ensure the group id resolved to a non-empty value before creating the category.
      if (!groupByName[cat.groupName]) {
        throw new Error(
          `Category group "${cat.groupName}" has no resolved group_id; `
          + `createCategoryGroup result was ${JSON.stringify(groupByName[cat.groupName])}`
        );
      }

      await actualApi.createCategory({
        name: cat.name,
        group_id: groupByName[cat.groupName],
        isIncome: cat.isIncome || false,
        hidden: false,
      });
    }
  } else if (fixture.categoryGroups) {
    // Legacy inline fixture shape: nested categoryGroups
    for (const group of fixture.categoryGroups) {
      const resolvedId = await resolveGroupId(
        group.name,
        await actualApi.createCategoryGroup({ name: group.name }),
      );
      for (const cat of (group.categories || [])) {
        // Ensure the group id resolved to a non-empty value before creating the category.
        if (!resolvedId) {
          throw new Error(
            `Category group "${group.name}" has no resolved group_id; `
            + `createCategoryGroup result was ${JSON.stringify(resolvedId)}`
          );
        }

        await actualApi.createCategory({
          name: cat.name,
          group_id: resolvedId,
          isIncome: cat.isIncome || false,
          hidden: cat.hidden || false,
        });
      }
    }
  }

  // ---- Accounts (canonical fields or legacy fields) ----
  if (fixture.accounts) {
    for (const acct of fixture.accounts) {
      // Canonical: accountType / offBudget / isClosed  |  Legacy: type / offbudget / closed
      const type = acct.accountType
        ? mapAccountType(acct.accountType)
        : (acct.type || 'other');
      const offbudget = (acct.offBudget !== undefined) ? acct.offBudget : (acct.offbudget || false);
      const closed = (acct.isClosed !== undefined) ? acct.isClosed : (acct.closed || false);
      await actualApi.createAccount({ name: acct.name, type, offbudget, closed });
    }
  }

  // Build name-based and fixture-id based maps after entity creation
  const accounts = await actualApi.getAccounts();
  const accountByName = {};
  const acctIdByFixId = {};
  for (const a of accounts) {
    const aName = (a).name;
    accountByName[aName] = a.id;
  }
  for (const fa of (fixture.accounts || [])) {
    if (fa.name && accountByName[fa.name]) {
      acctIdByFixId[fa.id] = accountByName[fa.name];
    }
  }

  // ---- Payees (canonical with transferAccountId or legacy with transferAcct) ----
  if (fixture.payees) {
    for (const payee of fixture.payees) {
      let transferAcct = null;
      if (payee.transferAccountId) {
        // Canonical: fixture-id reference → resolve to actual account ID
        transferAcct = acctIdByFixId[payee.transferAccountId] || null;
      } else if (payee.transferAcct) {
        // Legacy: direct value
        transferAcct = payee.transferAcct;
      }
      await actualApi.createPayee({ name: payee.name, transferAcct });
    }
  }

  // Build name-based payee and category maps
  const payeeByName = {};
  for (const p of await actualApi.getPayees()) payeeByName[p.name] = p.id;
  const catByName = {};
  for (const c of await actualApi.getCategories()) catByName[c.name] = c.id;
  // Also build fixture-id → name maps for canonical transaction resolution
  const payeeNameByFixId = {};
  for (const fp of (fixture.payees || [])) payeeNameByFixId[fp.id] = fp.name;
  const catNameByFixId = {};
  for (const fc of (fixture.categories || [])) catNameByFixId[fc.id] = fc.name;

  // ---- Transactions (canonical or legacy shape) ----
  if (fixture.transactions) {
    for (const txn of fixture.transactions) {
      // Resolve account: canonical accountId → fix-id map, or legacy account name
      let acctId;
      if (txn.accountId) {
        acctId = acctIdByFixId[txn.accountId];
      } else {
        acctId = accountByName[txn.account];
      }
      if (!acctId) continue;

      // Resolve payee: canonical payeeName, or legacy payee name string
      let payee = null;
      if (txn.payeeName) {
        payee = payeeByName[txn.payeeName] || null;
      } else if (txn.payee) {
        payee = payeeByName[txn.payee] || txn.payee;
      } else if (txn.payeeId) {
        const name = payeeNameByFixId[txn.payeeId];
        if (name) payee = payeeByName[name] || null;
      }

      // Resolve category: canonical categoryName, or legacy category name string
      let category = null;
      if (txn.categoryName) {
        category = catByName[txn.categoryName] || null;
      } else if (txn.category) {
        category = catByName[txn.category] || txn.category;
      } else if (txn.categoryId) {
        const name = catNameByFixId[txn.categoryId];
        if (name) category = catByName[name] || null;
      }

      // Parse amount: canonical Money { minorUnits: string, currency } or legacy integer
      let amount = 0;
      if (txn.amount != null && typeof txn.amount === 'object' && txn.amount.minorUnits != null) {
        amount = parseInt(txn.amount.minorUnits, 10);
        if (Number.isNaN(amount)) amount = 0;
      } else if (typeof txn.amount === 'number') {
        amount = txn.amount;
      }

      await actualApi.addTransactions(acctId, [{
        date: txn.date,
        amount,
        payee,
        category,
        notes: txn.notes || '',
        cleared: txn.cleared !== false,
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
      let payee = null;
      if (schedule.payeeName) {
        payee = payeeByName[schedule.payeeName] || null;
      } else if (schedule.payee) {
        payee = payeeByName[schedule.payee] || schedule.payee;
      }
      await actualApi.createSchedule({
        name: schedule.name,
        type: schedule.type || 'bill',
        amount: schedule.amount || 0,
        startDate: schedule.startDate,
        frequency: schedule.frequency || 'monthly',
        payee,
      });
    }
  }

  // Sync to server so the seeded data is uploaded
  await actualApi.sync();

  await actualApi.shutdown();
  console.log(JSON.stringify({
    status: 'seeded',
    budgetId: resolvedBudgetId,
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
  if [ "$DRY_RUN" = "1" ]; then
    cat << ENV
# === Actual Integration Test Environment (DRY RUN) ===
# The following would be exported:
ACTUAL_SERVER_URL='$ACTUAL_SERVER_URL'
ACTUAL_SECRET_KEY='$ACTUAL_SECRET_KEY'
ACTUAL_BUDGET_NAME='$ACTUAL_BUDGET_NAME'
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

  # Shell-quote all values with printf %q (handles spaces, quotes, etc.)
  local qs qk qb qg qn
  printf -v qs "%q" "$ACTUAL_SERVER_URL"
  printf -v qk "%q" "$ACTUAL_SECRET_KEY"
  printf -v qb "%q" "$budget_id"
  printf -v qg "%q" "$group_id"
  printf -v qn "%q" "$ACTUAL_BUDGET_NAME"

  cat > "$SCRIPT_DIR/.env.test" << ENV
ACTUAL_SERVER_URL=$qs
ACTUAL_SECRET_KEY=$qk
ACTUAL_BUDGET_ID=$qb
ACTUAL_GROUP_ID=$qg
ACTUAL_BUDGET_NAME=$qn
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
