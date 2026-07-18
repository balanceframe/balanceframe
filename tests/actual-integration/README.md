# Actual API Integration Tests

Integration tests proving the 7 API capabilities from the BalanceFrame roadmap.
These tests connect to a live Actual Budget server and exercise the full API surface
used by `@balanceframe/actual-adapter`.

## Prerequisites

- **Node.js** >= 20
- **pnpm** >= 9
- A running **Actual Budget server** (local or remote)
- The server's **secret key / password**

## Environment Variables

| Variable              | Required | Default                    | Description                          |
|-----------------------|----------|----------------------------|--------------------------------------|
| `ACTUAL_SERVER_URL`   | Yes      | `http://localhost:5006`    | URL of the Actual Budget server      |
| `ACTUAL_SECRET_KEY`   | Yes      | —                          | Server password / encryption key     |
| `ACTUAL_BUDGET_ID`    | No       | —                          | Pre-existing budget ID (if skipping setup) |
| `ACTUAL_GROUP_ID`     | No       | —                          | Pre-existing group ID (if skipping setup) |
| `ACTUAL_BUDGET_NAME`  | No       | `BalanceFrame Test Budget` | Name for the test budget             |

## Quick Start

### 1. Fixture Setup

Run the fixture setup script to start or connect to an Actual server and seed
a disposable test budget:

```bash
cd tests/actual-integration
./setup-fixture-server.sh
```

This script:
- Checks that Node.js, npx, curl, and jq are available
- Stops any running Actual server on the target port
- Creates a representative fixture data file (if missing)
- Starts the Actual server in server mode
- Creates a new test budget and seeds it with accounts, categories, payees,
  transactions, rules, and schedules
- Writes environment configuration to `.env.test`

For a dry run (preview without making changes):

```bash
DRY_RUN=1 ./setup-fixture-server.sh
```

### 2. Install Dependencies

```bash
cd tests/actual-integration
pnpm install
```

### 3. Run Tests

```bash
# From the tests/actual-integration directory:
pnpm test

# Or from the monorepo root:
pnpm --filter @balanceframe/actual-integration test
```

## Test Files

| File                           | Proof Points                                                                    |
|--------------------------------|---------------------------------------------------------------------------------|
| `01-connection-budget.test.ts` | Connect, discover budgets, select budget, encrypted/unencrypted budgets         |
| `02-sync-cache-lifecycle.test.ts` | Download budget, sync, cache isolation, cleanup, cross-budget isolation      |
| `03-read-entities.test.ts`     | Read accounts/categories/payees/transactions, rules/schedules, ActualQL, batch  |
| `04-observe-mode.test.ts`      | Uncategorized discovery, strict read-only, deterministic analysis               |
| `05-disposable-bank-sync.test.ts` | Bank sync sim, category updates, rule create/delete, rule learning           |
| `06-import-export.test.ts`     | Import dry-run, reconciliation, duplicate handling, export, restore             |
| `07-concurrency.test.ts`       | Concurrent reads, serialized writes, timeout/retry, version compatibility       |

## Test Architecture

Each test file:
1. Creates a **disposable budget** via `withActualClient` or `withTestBudget`
2. Seeds fixture data for realistic test scenarios
3. Exercises the specific API proof points
4. Cleans up the budget and disconnects from the server

The `helpers.ts` module provides:
- `withActualClient(fn)` — wraps tests with init/shutdown lifecycle
- `withTestBudget(fn)` — creates and cleans up a disposable budget
- `seedFixtureData()` — populates a budget from `protocol/fixtures/representative.json`
- `expectRejection(fn, predicate?)` — assert that an API call fails
- `syncWithServer()` — synchronize local changes to the server

## CI Integration

In CI, the test runner expects `ACTUAL_SERVER_URL` and `ACTUAL_SECRET_KEY` to be
provided by the CI environment (via secrets or a pre-configured test server).

Example GitHub Actions snippet:

```yaml
- name: Run Actual Integration Tests
  env:
    ACTUAL_SERVER_URL: ${{ secrets.ACTUAL_SERVER_URL }}
    ACTUAL_SECRET_KEY: ${{ secrets.ACTUAL_SECRET_KEY }}
  run: pnpm --filter @balanceframe/actual-integration test
```

## Notes

- Tests are **not** designed to run without a server — they will fail with
  connection errors if `ACTUAL_SERVER_URL` is unreachable.
- Each test creates its own budget to avoid cross-test contamination.
- Test timeouts are set to 60 seconds to accommodate network latency.
- Some tests use `retry: 1` in the vitest config to handle transient network issues.
- The `setup-fixture-server.sh` script handles both local and remote server modes.
