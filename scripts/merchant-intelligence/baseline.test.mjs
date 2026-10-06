import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { aggregate, describeSnapshot, expandSnapshot, parseArgs, percentile95 } from './baseline.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const seed = JSON.parse(readFileSync(path.join(ROOT, 'protocol/fixtures/representative.json'), 'utf8'));
const execute = promisify(execFile);
const runner = path.join(ROOT, 'scripts/merchant-intelligence/baseline.mjs');

// These tests are prepared for the primary to execute; no stub native module is used.
test('argument controls and nearest-rank p95 cannot silently hide invalid workloads', () => {
  const options = parseArgs(['--sizes', '3,120', '--iterations', '2', '--deadline-ms', '1000']);
  assert.deepEqual(options.sizes, [3, 120]);
  assert.equal(options.iterations, 2);
  assert.equal(options.deadlineMs, 1000);
  for (const args of [['--sizes', '250001'], ['--sizes', '0'], ['--sizes', '2,'],
    ['--iterations', 'NaN'], ['--deadline-ms', '0'], ['--iterations'], ['--unknown', '1']]) {
    assert.throws(() => parseArgs(args));
  }
  assert.equal(percentile95(Array.from({ length: 20 }, (_, index) => 20 - index)), 19);
  assert.equal(percentile95([3]), 3);
  assert.equal(percentile95([]), null);
});

test('expansion preserves canonical seed, creates unique records and partitions Money by account/currency/direction', () => {
  const original = JSON.stringify(seed);
  const size = seed.transactions.length + 120;
  const snapshot = expandSnapshot(seed, size);
  assert.deepEqual(snapshot, expandSnapshot(seed, size));
  assert.equal(JSON.stringify(seed), original);
  assert.deepEqual(snapshot.transactions.slice(0, seed.transactions.length), seed.transactions);
  assert.equal(snapshot.transactions.length, size);
  const generated = snapshot.transactions.slice(seed.transactions.length);
  for (const field of ['id', 'importedId']) {
    const seedIds = new Set(seed.transactions.map((transaction) => transaction[field]).filter(Boolean));
    const generatedIds = generated.map((transaction) => transaction[field]);
    assert(generatedIds.every((id) => typeof id === 'string' && id.length > 0 && !seedIds.has(id)));
    assert.equal(new Set(generatedIds).size, generated.length);
  }
  const generatedAccounts = new Map(snapshot.accounts.filter((account) => account.id.startsWith('perf-only-')).map((account) => [account.id, account]));
  assert.deepEqual([...generatedAccounts.values()].map((account) => account.clearedBalance.currency), ['USD', 'CAD', 'GBP']);
  assert.equal(new Set(generated.map((transaction) => BigInt(transaction.amount.minorUnits) < 0n
    ? (-BigInt(transaction.amount.minorUnits)).toString() : transaction.amount.minorUnits)).size, generated.length);
  const seedMaximum = seed.transactions.reduce((maximum, transaction) => {
    const amount = BigInt(transaction.amount.minorUnits);
    const absolute = amount < 0n ? -amount : amount;
    return absolute > maximum ? absolute : maximum;
  }, 0n);
  const endDate = seed.snapshotDate.slice(0, 10);
  const startDate = `${Number(endDate.slice(0, 4)) - 5}${endDate.slice(4)}`;
  for (const transaction of generated) {
    assert.equal(transaction.amount.currency, generatedAccounts.get(transaction.accountId).clearedBalance.currency);
    assert.match(transaction.amount.minorUnits, /^-?\d+$/);
    const amount = BigInt(transaction.amount.minorUnits);
    const absolute = amount < 0n ? -amount : amount;
    assert(absolute > seedMaximum && absolute <= 9223372036854775807n);
    assert.equal(new Date(`${transaction.date}T00:00:00Z`).toISOString().slice(0, 10), transaction.date);
    assert(transaction.date >= startDate && transaction.date <= endDate);
    assert.equal(transaction.subtransactions.length, 0);
    assert.equal(transaction.transferAccountId, null);
    assert(seed.payees.some((payee) => payee.id === transaction.payeeId));
    assert(transaction.categoryId === null || seed.categories.some((category) => category.id === transaction.categoryId));
  }
  const scope = describeSnapshot(snapshot, seed.transactions.length);
  assert.equal(scope.generatedTransactions, 120);
  assert.equal(scope.preservedSeedTransactions, seed.transactions.length);
  assert.equal(scope.partitions.reduce((sum, partition) => sum + partition.count, 0), size);
  for (const currency of ['USD', 'CAD', 'GBP']) {
    assert(scope.partitions.some((partition) => partition.accountId.startsWith('perf-only-') && partition.currency === currency && partition.direction === 'outflow'));
    assert(scope.partitions.some((partition) => partition.accountId.startsWith('perf-only-') && partition.currency === currency && partition.direction === 'inflow-or-zero'));
  }
  assert.deepEqual(expandSnapshot(seed, 3).transactions, seed.transactions.slice(0, 3));
  assert.throws(() => expandSnapshot(seed, 250001));
  assert.throws(() => expandSnapshot({ ...seed, accounts: [] }, size));
  for (const field of ['id', 'importedId']) {
    const collidingSeed = { ...seed, transactions: seed.transactions.map((transaction, index) =>
      index === 0 ? { ...transaction, [field]: generated[0][field] } : transaction) };
    assert.throws(() => expandSnapshot(collidingSeed, size), /Generated transaction\/import ID collision/);
  }
});

test('censored measurements never masquerade as a complete p95 or memory gate', () => {
  const completed = { status: 'completed', censored: false, elapsedMs: 5,
    memoryDeltaBytes: { rss: -12 }, processLifetimeMaxRssBytes: 50 };
  const partial = aggregate([completed, { status: 'timeout', censored: true }], 20);
  assert.equal(partial.p95ElapsedMs, null);
  assert.equal(partial.p95RssDeltaBytes, null);
  assert.equal(partial.p95ProcessLifetimeMaxRssBytes, null);
  assert.equal(partial.completedOnlyP95ElapsedMs, 5);
  assert.equal(partial.completedIterations, 1);
  assert.equal(partial.censoredIterations, 1);
  assert.equal(partial.unattemptedIterations, 18);
  const full = aggregate([completed], 1);
  assert.equal(full.p95ElapsedMs, 5);
  assert.equal(full.p95RssDeltaBytes, -12);
});

test('real compiled native subprocesses complete a controllably small serial baseline', async () => {
  const { stdout } = await execute(process.execPath, [runner, '--sizes', '3,6', '--iterations', '2', '--deadline-ms', '10000'],
    { cwd: ROOT, timeout: 30000, maxBuffer: 4 * 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.native.method, 'analyzeDeterministic');
  assert(report.environment.allowedCpuCount <= 2);
  assert.deepEqual(report.datasets.map((dataset) => dataset.requestedTransactions), [3, 6]);
  for (const dataset of report.datasets) {
    assert.equal(dataset.completedIterations, 2);
    assert.equal(dataset.censoredIterations, 0);
    assert.equal(dataset.unattemptedIterations, 0);
    assert(Number.isFinite(dataset.p95ElapsedMs));
    assert(Number.isFinite(dataset.p95RssDeltaBytes));
    assert(Number.isFinite(dataset.p95ProcessLifetimeMaxRssBytes));
    assert.equal(new Set(dataset.samples.map((sample) => sample.prepared.inputSha256)).size, 1);
    for (const sample of dataset.samples) {
      assert.equal(sample.prepared.description.transactionCount, dataset.requestedTransactions);
      assert.equal(sample.status, 'completed');
      assert.equal(sample.censored, false);
      assert(sample.summary.coverage);
      assert.equal(sample.memoryDeltaBytes.rss, sample.memoryAfter.rss - sample.memoryBefore.rss);
      assert(sample.processLifetimeMaxRssBytes > 0);
    }
  }
});

test('real subprocess deadline kills work and explicitly reports unattempted iterations', async () => {
  const { stdout } = await execute(process.execPath, [runner, '--sizes', '250000', '--iterations', '20', '--deadline-ms', '1'],
    { cwd: ROOT, timeout: 10000, maxBuffer: 1024 * 1024 });
  const report = JSON.parse(stdout);
  const dataset = report.datasets[0];
  assert.equal(dataset.completedIterations, 0);
  assert.equal(dataset.censoredIterations, 1);
  assert.equal(dataset.unattemptedIterations, 19);
  assert.equal(dataset.p95ElapsedMs, null);
  assert.equal(dataset.p95RssDeltaBytes, null);
  assert.equal(dataset.terminationReason, 'deadline_exceeded_stop_dataset');
  assert.equal(dataset.samples[0].nativeDurationUnknown, true);
  assert.equal(dataset.samples[0].signal, 'SIGKILL');
});
