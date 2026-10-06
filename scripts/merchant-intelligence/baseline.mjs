// Performance-only baseline. Never use generated categories as quality labels.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { fork } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '../..');
const DEFAULT_FIXTURE = path.join(ROOT, 'protocol/fixtures/representative.json');
const DEFAULT_NATIVE = path.join(ROOT, 'crates/node-binding/balanceframe.node');
const I64_MAX = 9223372036854775807n;

export function parseArgs(args) {
  const options = { sizes: [50000, 250000], iterations: 20, deadlineMs: 30000,
    fixture: DEFAULT_FIXTURE, native: DEFAULT_NATIVE, worker: false, help: false };
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (flag === '--help') { options.help = true; continue; }
    if (flag === '--worker') { options.worker = true; continue; }
    const value = args[++index];
    if (value === undefined) throw new Error(`Missing value for ${flag}`);
    if (flag === '--sizes') {
      options.sizes = value.split(',').map((size) => positiveInteger(size, '--sizes', 250000));
    } else if (flag === '--iterations') {
      options.iterations = positiveInteger(value, flag, 1000);
    } else if (flag === '--deadline-ms') {
      options.deadlineMs = positiveInteger(value, flag, 3600000);
    } else if (flag === '--fixture' || flag === '--native') {
      options[flag.slice(2)] = path.resolve(value);
    } else {
      throw new Error(`Unknown argument: ${flag}`);
    }
  }
  return options;
}

function positiveInteger(value, flag, maximum) {
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum) {
    throw new Error(`${flag} requires an integer in 1..${maximum}`);
  }
  return Number(value);
}

export function percentile95(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

/** Preserve canonical seed (including duplicate imports); only generated IDs must be unique. */
export function expandSnapshot(seed, size) {
  assert(Number.isSafeInteger(size) && size > 0 && size <= 250000, 'size must be 1..250000');
  for (const field of ['accounts', 'transactions', 'categories', 'payees', 'rules', 'schedules', 'budgets', 'tags']) {
    assert(Array.isArray(seed[field]), `Canonical snapshot requires ${field}`);
  }
  assert(typeof seed.snapshotDate === 'string', 'Canonical snapshot requires snapshotDate');
  const snapshot = structuredClone(seed);
  if (size < seed.transactions.length) {
    snapshot.transactions = snapshot.transactions.slice(0, size);
    return snapshot;
  }
  const templateAccount = seed.accounts.find((account) => !account.isClosed && !account.isExcluded);
  const payees = seed.payees.filter((payee) => !payee.transferAccountId);
  const categories = seed.categories.filter((category) => !category.deleted && !category.isIncome);
  assert(templateAccount && payees.length && categories.length, 'Expansion requires an account, payees and categories');
  const usedIds = new Set(seed.transactions.map((transaction) => transaction.id));
  const importedIds = new Set(seed.transactions.map((transaction) => transaction.importedId).filter(Boolean));
  const maximumSeedAmount = seed.transactions.reduce((maximum, transaction) => {
    const amount = BigInt(transaction.amount.minorUnits);
    const absolute = amount < 0n ? -amount : amount;
    return absolute > maximum ? absolute : maximum;
  }, 0n);
  assert(maximumSeedAmount + BigInt(size) <= I64_MAX, 'Seed leaves no safe unique i64 amount range');
  const accounts = ['USD', 'CAD', 'GBP'].map((currency) => ({
    ...templateAccount, id: `perf-only-account-${currency}`, name: `Generated performance-only ${currency}`,
    offBudget: false, isClosed: false, isExcluded: false, transferTo: null, transferFrom: null,
    clearedBalance: { minorUnits: '0', currency }, importedBalance: { minorUnits: '0', currency },
    mtid: null, bankSync: false,
  }));
  assert(accounts.every((account) => !seed.accounts.some((existing) => existing.id === account.id)), 'Generated account ID collision');
  snapshot.accounts.push(...accounts);
  const endDate = seed.snapshotDate.slice(0, 10);
  const end = Date.parse(`${endDate}T00:00:00Z`);
  const startDate = `${Number(endDate.slice(0, 4)) - 5}${endDate.slice(4)}`;
  const start = Date.parse(`${startDate}T00:00:00Z`);
  assert(Number.isFinite(start) && Number.isFinite(end), 'Seed date must be an ISO civil date');
  const days = Math.floor((end - start) / 86400000) + 1;
  for (let index = 0; snapshot.transactions.length < size; index++) {
    const id = `perf-only-transaction-${index}`;
    const importedId = `perf-only-import-${index}`;
    assert(!usedIds.has(id) && !importedIds.has(importedId), 'Generated transaction/import ID collision');
    const account = accounts[index % accounts.length];
    const payee = payees[Math.floor(index / accounts.length) % payees.length];
    const category = index % 5 === 0 ? null : categories[Math.floor(index / payees.length) % categories.length];
    const absolute = maximumSeedAmount + BigInt(index) + 1n;
    snapshot.transactions.push({
      id, accountId: account.id,
      date: new Date(start + ((index * 37) % days) * 86400000).toISOString().slice(0, 10),
      payeeId: payee.id, payeeName: payee.name,
      categoryId: category?.id ?? null, categoryName: category?.name ?? null,
      amount: { minorUnits: (index % 10 === 0 ? absolute : -absolute).toString(), currency: account.clearedBalance.currency },
      cleared: index % 5 !== 0, reconciled: false, importedId,
      importedPayee: `PERF ONLY ${payee.name}`, notes: null, tags: [], transferAccountId: null, subtransactions: [],
    });
  }
  return snapshot;
}

export function describeSnapshot(snapshot, seedCount) {
  const accounts = new Map(snapshot.accounts.map((account) => [account.id, account]));
  const partitions = new Map();
  let uncategorized = 0;
  let uncleared = 0;
  let startDate = null;
  let endDate = null;
  for (const transaction of snapshot.transactions) {
    assert(accounts.has(transaction.accountId), `Unknown account: ${transaction.accountId}`);
    const direction = BigInt(transaction.amount.minorUnits) < 0n ? 'outflow' : 'inflow-or-zero';
    const key = JSON.stringify([transaction.accountId, transaction.amount.currency, direction]);
    partitions.set(key, (partitions.get(key) ?? 0) + 1);
    if (!transaction.categoryId) uncategorized++;
    if (!transaction.cleared) uncleared++;
    if (startDate === null || transaction.date < startDate) startDate = transaction.date;
    if (endDate === null || transaction.date > endDate) endDate = transaction.date;
  }
  return {
    transactionCount: snapshot.transactions.length,
    preservedSeedTransactions: Math.min(seedCount, snapshot.transactions.length),
    generatedTransactions: Math.max(0, snapshot.transactions.length - seedCount),
    accountCount: snapshot.accounts.length, payeeCount: snapshot.payees.length,
    distinctTransactionPayeeIds: new Set(snapshot.transactions.map((transaction) => transaction.payeeId)).size,
    categoryCount: snapshot.categories.length, ruleCount: snapshot.rules.length, scheduleCount: snapshot.schedules.length,
    uncategorizedCount: uncategorized, unclearedCount: uncleared, startDate, endDate,
    partitions: [...partitions].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
      const [accountId, currency, direction] = JSON.parse(key);
      return { accountId, currency, direction, count };
    }),
  };
}

function summarizeResponse(response, requestId) {
  assert(response.requestId === requestId && response.analysis && response.coverage, 'Unexpected native response shape');
  const analysis = response.analysis;
  return { status: response.status, reasonCodes: response.reasonCodes, coverage: response.coverage,
    resultCounts: Object.fromEntries(['repeatedMerchants', 'deterministicClassifications', 'ruleCandidates',
      'duplicateEvidence', 'recurringCharges', 'historicalCorrections', 'blockers'].map((field) => {
        assert(Array.isArray(analysis[field]), `Missing native result collection: ${field}`);
        return [field, analysis[field].length];
      })), uncategorizedBacklogCount: analysis.uncategorizedBacklog.transactionIds.length };
}

function worker(options) {
  assert(process.send && options.sizes.length === 1, '--worker is reserved for the subprocess harness');
  const native = createRequire(import.meta.url)(options.native);
  assert(typeof native.analyzeDeterministic === 'function', 'Compiled native module must export analyzeDeterministic');
  const preparationStart = performance.now();
  const seed = JSON.parse(readFileSync(options.fixture, 'utf8'));
  const snapshot = expandSnapshot(seed, options.sizes[0]);
  const requestId = `merchant-intelligence-baseline-${options.sizes[0]}`;
  const input = JSON.stringify({ snapshot, options: { includePending: true, includeCleared: true, maxResults: null }, requestId, actorId: null });
  const description = describeSnapshot(snapshot, seed.transactions.length);
  const prepared = { description, requestBytes: Buffer.byteLength(input), inputSha256: sha256(input),
    preparationElapsedMs: performance.now() - preparationStart, memoryBefore: process.memoryUsage() };
  process.send({ kind: 'started', prepared }, (error) => {
    if (error) throw error;
    const memoryBefore = process.memoryUsage();
    const start = performance.now();
    const raw = native.analyzeDeterministic(input);
    const elapsedMs = performance.now() - start;
    const memoryAfter = process.memoryUsage();
    // Capture process memory before parsing the returned JSON; parsing is outside native timing.
    const maxRssBytes = process.resourceUsage().maxRSS * 1024; // Linux reports KiB.
    assert(typeof raw === 'string', 'Native method must return JSON text');
    const summary = summarizeResponse(JSON.parse(raw), requestId);
    process.send({ kind: 'completed', measurement: {
      elapsedMs, memoryBefore, memoryAfter,
      memoryDeltaBytes: Object.fromEntries(Object.keys(memoryAfter).map((field) => [field, memoryAfter[field] - memoryBefore[field]])),
      processLifetimeMaxRssBytes: maxRssBytes, responseBytes: Buffer.byteLength(raw), summary,
    } }, () => process.disconnect());
  });
}

function measure(options, size) {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    const child = fork(SCRIPT, ['--worker', '--sizes', String(size), '--fixture', options.fixture, '--native', options.native],
      { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], execArgv: [] });
    let prepared = null;
    let nativeStartedAt = null;
    let measurement = null;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, options.deadlineMs);
    child.on('message', (message) => {
      if (message.kind === 'started') { prepared = message.prepared; nativeStartedAt = performance.now(); }
      if (message.kind === 'completed') measurement = message.measurement;
    });
    child.once('error', (error) => { clearTimeout(timer); reject(error); });
    child.once('exit', () => clearTimeout(timer));
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      if (timedOut) {
        resolve({ status: 'timeout', prepared, deadlineMs: options.deadlineMs,
          subprocessElapsedMs: performance.now() - startedAt,
          elapsedSincePreparationObservedMs: nativeStartedAt === null ? null : performance.now() - nativeStartedAt,
          nativeDurationUnknown: measurement === null, completedNativeMeasurement: measurement,
          censored: true, signal });
      } else if (code !== 0 || !measurement) {
        reject(new Error(`Native subprocess failed for ${size} transactions (exit=${code}, signal=${signal})`));
      } else {
        resolve({ status: 'completed', prepared, subprocessElapsedMs: performance.now() - startedAt, censored: false, ...measurement });
      }
    });
  });
}

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }
function optionalFile(file) { try { return readFileSync(file, 'utf8').trim(); } catch { return null; } }

export function aggregate(samples, requestedIterations) {
  const completed = samples.filter((sample) => sample.status === 'completed');
  const censoredCount = samples.filter((sample) => sample.censored).length;
  const complete = completed.length === requestedIterations && censoredCount === 0;
  const p95 = (get) => percentile95(completed.map(get));
  return { requestedIterations, attemptedIterations: samples.length, completedIterations: completed.length,
    censoredIterations: censoredCount, unattemptedIterations: requestedIterations - samples.length,
    terminationReason: censoredCount ? 'deadline_exceeded_stop_dataset' : 'completed',
    p95ElapsedMs: complete ? p95((sample) => sample.elapsedMs) : null,
    completedOnlyP95ElapsedMs: p95((sample) => sample.elapsedMs),
    p95RssDeltaBytes: complete ? p95((sample) => sample.memoryDeltaBytes.rss) : null,
    p95ProcessLifetimeMaxRssBytes: complete ? p95((sample) => sample.processLifetimeMaxRssBytes) : null,
    samples };
}

async function main(options) {
  if (options.help) {
    process.stdout.write('Usage: taskset -c 0,1 node scripts/merchant-intelligence/baseline.mjs [--sizes 50000,250000] [--iterations 20] [--deadline-ms 30000] [--fixture path] [--native path]\nStops a dataset at its first timeout; p95 is null for incomplete/censored runs. Outputs JSON, never pass/fail performance gates.\n');
    return;
  }
  if (options.worker) { worker(options); return; }
  assert(process.platform === 'linux', 'Reference measurements require Linux (maxRSS units and CPU affinity reporting)');
  const cpuStatus = readFileSync('/proc/self/status', 'utf8');
  const allowedList = /^Cpus_allowed_list:\s*(.+)$/m.exec(cpuStatus)?.[1]?.trim();
  assert(allowedList, 'Cannot inspect effective CPU affinity');
  const allowedCount = allowedList.split(',').reduce((count, range) => {
    const [start, end = start] = range.split('-').map(Number);
    return count + end - start + 1;
  }, 0);
  assert(allowedCount <= 2, `Use taskset to cap to two allowed cores; current affinity=${allowedList}`);
  const spec = JSON.parse(readFileSync(path.join(path.dirname(SCRIPT), 'benchmark-spec.json'), 'utf8'));
  const report = { schemaVersion: '1', benchmark: 'legacy-analyzeDeterministic-baseline', measuredAt: new Date().toISOString(),
    environment: { platform: process.platform, architecture: process.arch, kernel: os.release(), node: process.version,
      versions: process.versions, cpuModels: [...new Set(os.cpus().map((cpu) => cpu.model))],
      availableParallelism: os.availableParallelism(), effectiveCpuAffinity: allowedList, allowedCpuCount: allowedCount,
      cpuCapMethod: 'inherited scheduler affinity, not dedicated cores or a utilization/quota guarantee',
      cgroupMembership: optionalFile('/proc/self/cgroup'), rootCgroupCpuMax: optionalFile('/sys/fs/cgroup/cpu.max') },
    fixture: { path: options.fixture, sha256: sha256(readFileSync(options.fixture)) },
    native: { path: options.native, sha256: sha256(readFileSync(options.native)), method: 'analyzeDeterministic',
      buildProfile: 'not inferable from binary; caller must use release build command' },
    configuration: { sizes: options.sizes, iterations: options.iterations, deadlineMs: options.deadlineMs }, spec, datasets: [] };
  for (const size of options.sizes) {
    const samples = [];
    for (let iteration = 0; iteration < options.iterations; iteration++) {
      const sample = await measure(options, size);
      samples.push({ iteration: iteration + 1, ...sample });
      if (sample.censored) break;
    }
    report.datasets.push({ requestedTransactions: size, ...aggregate(samples, options.iterations) });
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  Promise.resolve().then(() => main(parseArgs(process.argv.slice(2)))).catch((error) => {
    process.stderr.write(`${JSON.stringify({ status: 'error', message: error.message })}\n`);
    process.exitCode = 1;
  });
}
