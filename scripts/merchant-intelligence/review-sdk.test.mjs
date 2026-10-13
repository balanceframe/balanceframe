import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createOwnedScenarioRoot, discardOwnedScenarioRoot, startScenarioShell, stopScenarioProcesses } from '../../packages/scenario-kit/dist/scenario-kit/src/process-runtime.js';
import { materializeScenario } from '../../packages/scenario-kit/dist/scenario-kit/src/catalog.js';
import { builtWebEntry, initializeScenarioShell } from '../../packages/scenario-kit/dist/scenario-kit/src/loader.js';
import { buildTransactions, publishActualSnapshot } from './review.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const requireFromScenario = createRequire(path.join(ROOT, 'packages/scenario-kit/package.json'));
const actualApi = requireFromScenario('@actual-app/api');
const ANCHOR = new Date('2026-10-04T12:00:00.000Z');
const REQUESTED_ROWS = 250_000;
const BATCH_SIZE = 500;
const START_DATE = '0001-01-01';
const END_DATE = '9999-12-31';

function assertFixtureFacts(row, transaction, seeded, accountId) {
  const amount = BigInt(transaction.amount.minorUnits);
  assert(amount >= -BigInt(Number.MAX_SAFE_INTEGER) && amount <= BigInt(Number.MAX_SAFE_INTEGER));
  assert.deepEqual({
    id: row.id,
    account: row.account,
    date: row.date,
    amount: row.amount,
    payee: row.payee,
    category: row.category,
    imported_id: row.imported_id,
    imported_payee: row.imported_payee,
    notes: row.notes,
    cleared: row.cleared,
    reconciled: row.reconciled,
    subtransactions: row.subtransactions,
  }, {
    id: seeded.transactionIds[transaction.id],
    account: accountId,
    date: transaction.date,
    amount: Number(amount),
    payee: transaction.payeeId === null ? null : seeded.payeeIds[transaction.payeeId],
    category: transaction.categoryId === null ? null : seeded.categoryIds[transaction.categoryId],
    imported_id: transaction.importedId,
    imported_payee: transaction.importedPayee,
    notes: transaction.notes ?? '',
    cleared: transaction.cleared,
    reconciled: transaction.reconciled,
    subtransactions: [],
  });
}

test('Actual SDK returns complete 250k grouped history and independently published financial facts',
  { timeout: 1_800_000 }, async () => {
    const root = createOwnedScenarioRoot();
    let processes;
    let sdkInitAttempted = false;
    let retainRoot = false;
    try {
      // Canonical fictional merchant data needs no provider dispatch.
      const scenario = materializeScenario('merchant-local-sparse', ANCHOR);
      processes = await startScenarioShell({ root, webEntry: builtWebEntry(), scenarioId: scenario.id });
      const loaded = await initializeScenarioShell(processes, scenario);
      const template = scenario.ledger.transactions.find((row) => row.categoryId !== null && row.payeeId !== null);
      assert(template, 'Canonical merchant fixture has no categorized USD template row');
      assert(scenario.ledger.accounts.every((account) => account.clearedBalance.currency === 'USD' &&
        account.importedBalance.currency === 'USD'));
      const accountId = loaded.seeded.accountIds[template.accountId];
      const payeeId = loaded.seeded.payeeIds[template.payeeId];
      const categoryId = loaded.seeded.categoryIds[template.categoryId];
      assert(accountId && payeeId && categoryId, 'Canonical fixture IDs were not seeded into Actual');

      const clientDir = mkdtempSync(path.join(root, 'actual-sdk-client-'));
      sdkInitAttempted = true;
      const actualClient = await actualApi.init({ serverURL: processes.actualUrl, password: processes.actualSecretKey, dataDir: clientDir });
      await actualApi.downloadBudget(loaded.seeded.groupId);
      await assert.rejects(
        publishActualSnapshot(actualClient, 'not-the-owned-fixture'),
        /actual_budget_snapshot_identity_mismatch/,
      );
      const unchangedPreferences = await actualClient.send('load-prefs');
      assert.equal(unchangedPreferences.cloudFileId, loaded.seeded.budgetId);
      assert.equal(unchangedPreferences.groupId, loaded.seeded.groupId);
      const fixtureRows = scenario.ledger.transactions.filter((row) => row.accountId === template.accountId);
      assert(fixtureRows.every((row) => row.subtransactions.length === 0),
        'This compact merchant fixture has no splits; actual-seed.test.ts covers real Actual parent/child readback');
      const canonicalAccount = scenario.ledger.accounts.find((row) => row.id === template.accountId);
      assert(canonicalAccount);
      assert.equal(canonicalAccount.importedBalance.currency, 'USD');
      assert.equal(canonicalAccount.clearedBalance.minorUnits, canonicalAccount.importedBalance.minorUnits);
      const fixtureMinorUnits = fixtureRows.reduce((sum, row) => sum + BigInt(row.amount.minorUnits), 0n);
      const openingMinorUnits = BigInt(canonicalAccount.importedBalance.minorUnits) - fixtureMinorUnits;
      assert(openingMinorUnits >= -BigInt(Number.MAX_SAFE_INTEGER) &&
        openingMinorUnits <= BigInt(Number.MAX_SAFE_INTEGER));
      const baseline = await actualApi.getTransactions(accountId, START_DATE, END_DATE);
      assert.equal(baseline.length, fixtureRows.length + 1);
      const fixtureByNativeId = new Map();
      for (const row of fixtureRows) {
        const nativeId = loaded.seeded.transactionIds[row.id];
        assert.equal(typeof nativeId, 'string');
        assert(!fixtureByNativeId.has(nativeId));
        fixtureByNativeId.set(nativeId, row);
      }
      const seenBaselineFixtureIds = new Set();
      const openingByNativeId = new Map();
      for (const row of baseline) {
        const source = fixtureByNativeId.get(row.id);
        if (source) {
          assertFixtureFacts(row, source, loaded.seeded, accountId);
          seenBaselineFixtureIds.add(row.id);
          continue;
        }
        assert.equal(typeof row.id, 'string');
        assert.equal(row.account, accountId);
        assert.equal(row.amount, Number(openingMinorUnits));
        assert.equal(row.starting_balance_flag, true);
        assert(!openingByNativeId.has(row.id));
        openingByNativeId.set(row.id, {
          id: row.id, account: accountId, amount: Number(openingMinorUnits), starting_balance_flag: true,
        });
      }
      assert.equal(seenBaselineFixtureIds.size, fixtureRows.length);
      assert.equal(openingByNativeId.size, 1);
      const balanceBefore = await actualApi.getAccountBalance(accountId);
      assert(Number.isSafeInteger(balanceBefore), 'Actual account balance is not an exact safe integer');
      assert.equal(BigInt(balanceBefore), BigInt(canonicalAccount.importedBalance.minorUnits));
      const appendCount = REQUESTED_ROWS - baseline.length;
      assert(appendCount > 0);
      const generated = buildTransactions(scenario.ledger, appendCount, {
        accountId, payeeId, categoryId, initialBalanceMinorUnits: balanceBefore, importPrefix: REQUESTED_ROWS,
        analysisStartDate: '2021-10-04', analysisEndDate: '2026-10-04',
      });
      assert.equal(generated.length, appendCount);
      const expectedByImportId = new Map(generated.map((row) => [row.imported_id, row]));
      assert.equal(expectedByImportId.size, generated.length);
      const generatedMinorUnits = generated.reduce((sum, row) => {
        assert(Number.isSafeInteger(row.amount));
        return sum + BigInt(row.amount);
      }, 0n);
      const expectedBalance = BigInt(balanceBefore) + generatedMinorUnits;
      assert(expectedBalance >= -BigInt(Number.MAX_SAFE_INTEGER) && expectedBalance <= BigInt(Number.MAX_SAFE_INTEGER));

      for (let offset = 0; offset < generated.length; offset += BATCH_SIZE) {
        await actualApi.addTransactions(accountId, generated.slice(offset, offset + BATCH_SIZE), {
          runTransfers: false, learnCategories: false,
        });
        await actualApi.sync();
      }

      // Read the published, bounded-batch SDK history through the public grouped query.
      const rows = await actualApi.getTransactions(accountId, START_DATE, END_DATE);
      assert.equal(rows.length, REQUESTED_ROWS);
      const seenNativeIds = new Set();
      const seenFixtureIds = new Set();
      const seenOpeningIds = new Set();
      const seenGeneratedImports = new Set();
      const generatedNativeIds = new Set();
      for (const row of rows) {
        assert.equal(typeof row.id, 'string');
        assert(!seenNativeIds.has(row.id), `Duplicate native transaction ID ${row.id}`);
        seenNativeIds.add(row.id);
        const fixture = fixtureByNativeId.get(row.id);
        if (fixture) {
          assertFixtureFacts(row, fixture, loaded.seeded, accountId);
          seenFixtureIds.add(row.id);
          continue;
        }
        const opening = openingByNativeId.get(row.id);
        if (opening) {
          assert.deepEqual({
            id: row.id, account: row.account, amount: row.amount,
            starting_balance_flag: row.starting_balance_flag,
          }, opening);
          seenOpeningIds.add(row.id);
          continue;
        }
        const expected = expectedByImportId.get(row.imported_id);
        assert(expected, `Unexpected Actual transaction ${row.id}`);
        assert(!seenGeneratedImports.has(row.imported_id), `Duplicate requested import ID ${row.imported_id}`);
        seenGeneratedImports.add(row.imported_id);
        generatedNativeIds.add(row.id);
        assert.deepEqual({
          account: row.account,
          date: row.date,
          amount: row.amount,
          payee: row.payee,
          category: row.category,
          imported_id: row.imported_id,
          imported_payee: row.imported_payee,
          notes: row.notes,
          cleared: row.cleared,
          reconciled: row.reconciled,
        }, {
          account: accountId,
          date: expected.date,
          amount: expected.amount,
          payee: payeeId,
          category: categoryId,
          imported_id: expected.imported_id,
          imported_payee: expected.imported_payee,
          notes: expected.notes,
          cleared: true,
          reconciled: false,
        });
      }
      assert.deepEqual(seenFixtureIds, new Set(fixtureByNativeId.keys()));
      assert.deepEqual(seenOpeningIds, new Set(openingByNativeId.keys()));
      assert.deepEqual(seenGeneratedImports, new Set(expectedByImportId.keys()));
      assert.equal(generatedNativeIds.size, generated.length);
      assert.equal(seenNativeIds.size, REQUESTED_ROWS);

      const balanceAfter = await actualApi.getAccountBalance(accountId);
      assert(Number.isSafeInteger(balanceAfter), 'Actual account balance is not an exact safe integer');
      assert.equal(balanceAfter, Number(expectedBalance));

      const publishedGroupId = await publishActualSnapshot(actualClient, loaded.seeded.budgetId);
      assert.notEqual(publishedGroupId, loaded.seeded.groupId);
      await actualApi.shutdown();
      sdkInitAttempted = false;
      const independentDir = mkdtempSync(path.join(root, 'actual-sdk-independent-'));
      sdkInitAttempted = true;
      const independentClient = await actualApi.init({ serverURL: processes.actualUrl, password: processes.actualSecretKey, dataDir: independentDir });
      await actualApi.downloadBudget(publishedGroupId);
      const publishedPreferences = await independentClient.send('load-prefs');
      assert.equal(publishedPreferences.cloudFileId, loaded.seeded.budgetId);
      assert.equal(publishedPreferences.groupId, publishedGroupId);
      const independentRows = await actualApi.getTransactions(accountId, START_DATE, END_DATE);
      assert.equal(independentRows.length, REQUESTED_ROWS);
      assert.deepEqual(new Set(independentRows.map((row) => row.id)), seenNativeIds);
      const originalById = new Map(rows.map((row) => [row.id, row]));
      const financialFields = ['account', 'date', 'amount', 'payee', 'category', 'imported_id',
        'imported_payee', 'notes', 'cleared', 'reconciled', 'starting_balance_flag'];
      for (const row of independentRows) {
        const original = originalById.get(row.id);
        assert(original);
        for (const field of financialFields) assert.deepEqual(row[field], original[field]);
      }
      assert.equal(await actualApi.getAccountBalance(accountId), Number(expectedBalance));
    } catch (error) {
      retainRoot = error instanceof Error && 'ownedCleanupUnproven' in error && error.ownedCleanupUnproven === true;
      throw error;
    } finally {
      try {
        if (sdkInitAttempted) {
          try {
            await actualApi.shutdown();
          } catch (error) {
            retainRoot = true;
            throw error;
          }
        }
      } finally {
        if (processes) await stopScenarioProcesses(processes, { retainRoot });
        else if (!retainRoot) discardOwnedScenarioRoot(root);
      }
    }
  });
