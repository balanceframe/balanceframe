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

## Manual Actual Baseline Methodology

Beyond the automated integration tests, BalanceFrame maintains a **manual baseline**
methodology that captures real-world Actual Budget behavior for comparison.
This is the "ground truth" against which the automated review-workflow output is
validated.

### Purpose

The automated tests prove API coverage and deterministic read-only behavior, but
they cannot fully replicate the human review workflow: a user opening Actual's
web UI, inspecting uncleared transactions, assigning categories, and reconciling
accounts. The manual baseline captures that workflow end-to-end so that review-
workflow suggestions can be compared against what a human actually did.

### Prerequisites

- A running Actual Budget server (local or remote)
- The `setup-fixture-server.sh` script has been run to seed the `representative.json`
  fixture into a disposable budget
- Node.js >= 20 and a modern browser (Chrome/Firefox) to access the Actual UI

### How to Run the Manual Baseline

1. **Start Actual with the fixture:**

   ```bash
   cd tests/actual-integration
   ./setup-fixture-server.sh
   ```

   This seeds the representative fixture into a new budget and starts the server.

2. **Open the Actual UI** in a browser at the server URL (default `http://localhost:5006`).

3. **Navigate to the test budget** (named `BalanceFrame Test Budget` by default).

4. **Work through the uncategorized transactions** as a human reviewer would:
   - Open the "Transactions" view, filter by uncategorized.
   - For each uncategorized transaction, examine the payee, amount, and memo.
   - Assign a category based on your knowledge of the budget structure.
   - Record the time taken per transaction and the final category assignment.

5. **Record the results** in a structured format (CSV or JSON):
   - Transaction ID
   - Chosen category ID
   - Time to categorize (seconds)
   - Confidence level (high / medium / low)

### Time-to-Categorize Measurement

The time-to-categorize measurement is a critical output of the manual baseline:

- Start a stopwatch when you begin reviewing a transaction (after reading its details).
- Stop when you have selected a category and confirmed the assignment.
- Record the elapsed time in seconds.
- Discard any measurement where you were interrupted or had to re-familiarize
  yourself with the budget structure (the first 2-3 transactions often take longer).
- Calculate summary statistics (mean, median, P90, P99) for the remaining measurements.

This gives a benchmark for the automated review workflow: if the automated system
categorizes transactions as accurately as a human but in milliseconds, that is the
baseline to beat.

### Later Review-Workflow Baseline

Once the automated review workflow is implemented:

1. Run the review workflow against the same representative fixture.
2. Compare the automated category assignments against the manual baseline.
3. Measure:
   - **Accuracy**: fraction of automated assignments matching the manual baseline.
   - **Coverage**: fraction of uncategorized transactions the system proposed a
     category for (vs. declining with low confidence).
   - **Speed**: time-to-categorize for the automated pipeline.
4. Flag discrepancies where the automated system disagrees with the human judgment
   — these become training data for improving the classifiers.

### Comparison to Automated Tests

| Aspect | Automated Tests | Manual Baseline |
|--------|----------------|-----------------|
| Scope | API correctness, data integrity, determinism | End-to-end human review workflow |
| Data | Synthetic fixture | Same fixture, but exercised through the UI |
| Measurement | Pass/fail assertions | Time-to-categorize, accuracy, coverage |
| Repeatability | Fully deterministic | Subject to human variation |
| Cadence | CI / every commit | Periodic (per milestone / schema change) |

The two approaches are complementary: automated tests catch regressions in the
analysis pipeline, while the manual baseline validates that the pipeline's output
is meaningful for real human reviewers.
