import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, readdirSync, rmSync, rmdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');

function proveOwnedRetainedRoot(clientDataDir, expectedClientDir = 'actual-writer') {
  assert.equal(path.basename(clientDataDir), expectedClientDir);
  const root = path.dirname(clientDataDir);
  const parent = path.dirname(root);
  assert(path.basename(root).startsWith('workspace-'));
  assert(path.basename(parent).startsWith('balanceframe-scenario-parent-'));
  for (const directory of [parent, root]) {
    const stats = lstatSync(directory);
    assert(stats.isDirectory() && !stats.isSymbolicLink());
    assert.equal(stats.mode & 0o777, 0o700);
    assert.equal(realpathSync(directory), directory);
  }
  assert.deepEqual(readdirSync(parent), [path.basename(root)]);
  for (const name of ['home', 'tmp', 'credentials', 'actual']) {
    const directory = path.join(root, name);
    const stats = lstatSync(directory);
    assert(stats.isDirectory() && !stats.isSymbolicLink());
    assert.equal(stats.mode & 0o777, 0o700);
  }
  const manifest = lstatSync(path.join(root, 'manifest.json'));
  assert(manifest.isFile() && !manifest.isSymbolicLink());
  assert.equal(manifest.mode & 0o777, 0o600);
  return { root, parent };
}

async function runCleanupReview(t, fault, sizes) {
  const artifacts = mkdtempSync(path.join(tmpdir(), 'balanceframe-review-cleanup-test-'));
  chmodSync(artifacts, 0o700);
  const faultEntry = path.join(artifacts, 'fault-entry.mjs');
  const faultEvents = path.join(artifacts, 'fault-events.json');
  const output = path.join(artifacts, 'review.json');
  const faultSource = `
import { writeFileSync } from 'node:fs';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import path from 'node:path';
import { mock } from 'node:test';
import * as childProcess from 'node:child_process';

const root = ${JSON.stringify(ROOT)};
const eventsFile = ${JSON.stringify(faultEvents)};
const faultMode = process.env.BALANCEFRAME_REVIEW_CLEANUP_FAULT;
const nativeFetch = globalThis.fetch;
let runnerFetchBridge = null;
let forwardingFetchBridge = false;
const capturedFetch = (...args) => {
  if (runnerFetchBridge && !forwardingFetchBridge) {
    forwardingFetchBridge = true;
    try { return runnerFetchBridge.apply(globalThis, args); }
    finally { forwardingFetchBridge = false; }
  }
  return nativeFetch.apply(globalThis, args);
};
Object.defineProperty(globalThis, 'fetch', {
  configurable: true,
  enumerable: true,
  get: () => capturedFetch,
  set: (value) => {
    if (runnerFetchBridge === null && value !== capturedFetch && value !== nativeFetch && typeof value === 'function')
      runnerFetchBridge = value;
  },
});
const requireFromScenario = createRequire(path.join(root, 'packages/scenario-kit/package.json'));
const seedDataDirs = [];
const writerDataDirs = [];
let seedInitAttempts = 0;
let seedInitAcquisitions = 0;
let seedInitFailures = 0;
let seedShutdownCalls = 0;
let seedShutdownFailures = 0;
let harnessSeedFinalizations = 0;
let writerInitFailures = 0;
let writerShutdownFailures = 0;
let childProcessesStarted = 0;
let childProcessesClosed = 0;
let seedClientOpen = false;
let partialWriterOpen = false;
const actualSpawn = childProcess.default.spawn;
mock.method(childProcess.default, 'spawn', function (...args) {
  const child = actualSpawn.apply(this, args);
  childProcessesStarted += 1;
  child.once('close', () => { childProcessesClosed += 1; });
  return child;
});
syncBuiltinESMExports();

const actualApi = requireFromScenario('@actual-app/api');
const actualInit = actualApi.init;
const actualShutdown = actualApi.shutdown;
const initImplementation = async (options) => {
  const isSeedClient = typeof options?.dataDir === 'string' &&
    path.basename(options.dataDir) === 'seed-client';
  if (isSeedClient) {
    seedInitAttempts += 1;
    seedDataDirs.push(options.dataDir);
  }
  const result = await actualInit.call(actualApi, options);
  if (isSeedClient) {
    seedInitAcquisitions += 1;
    seedClientOpen = true;
    if (faultMode === 'seed-lifecycle' && seedInitAcquisitions === 1) {
      seedInitFailures += 1;
      // A red run can leave this SDK open after the pre-fix partial-init path.
      setTimeout(() => {
        if (seedClientOpen) {
          seedClientOpen = false;
          harnessSeedFinalizations += 1;
          void actualShutdown.apply(actualApi).catch(() => {});
        }
      }, 1000);
      throw new Error('injected_actual_seed_init_failure');
    }
  }
  if (typeof options?.dataDir === 'string' && path.basename(options.dataDir) === 'actual-writer') {
    writerDataDirs.push(options.dataDir);
    if (faultMode === 'writer-partial-init') {
      partialWriterOpen = true;
      writerInitFailures += 1;
      throw new Error('injected_actual_writer_init_failure');
    }
  }
  return result;
};
const shutdownImplementation = async (...args) => {
  const result = await actualShutdown.apply(actualApi, args);
  if (partialWriterOpen) {
    partialWriterOpen = false;
    writerShutdownFailures += 1;
    throw new Error('injected_actual_writer_shutdown_failure');
  }
  if (seedClientOpen) {
    seedClientOpen = false;
    seedShutdownCalls += 1;
    if (faultMode === 'seed-lifecycle' && seedInitAcquisitions === 2) {
      seedShutdownFailures += 1;
      throw new Error('injected_actual_seed_shutdown_failure');
    }
  }
  return result;
};
mock.method(actualApi, 'init', initImplementation);
mock.method(actualApi, 'shutdown', shutdownImplementation);

process.once('exit', () => writeFileSync(eventsFile, JSON.stringify({
  seedDataDirs, writerDataDirs, seedInitAttempts, seedInitAcquisitions, seedInitFailures,
  seedShutdownCalls, seedShutdownFailures, harnessSeedFinalizations,
  writerInitFailures, writerShutdownFailures, childProcessesStarted, childProcessesClosed,
}), { flag: 'wx', mode: 0o600 }));

`;
  writeFileSync(faultEntry, faultSource, { flag: 'wx', mode: 0o600 });
  let childClosed = false;
  let retainedRoot = null;
  let child;
  const onAbort = () => child?.kill('SIGTERM');
  t.signal.addEventListener('abort', onAbort, { once: true });
  try {
    child = spawn(process.execPath, [
      '--import', faultEntry,
      path.join(ROOT, 'scripts/merchant-intelligence/review.mjs'),
      '--sizes', sizes, '--warmups', '1', '--iterations', '1', '--deadline-ms', '30000',
      '--output', output,
    ], {
      cwd: ROOT,
      env: { ...process.env, BALANCEFRAME_REVIEW_CLEANUP_FAULT: fault },
      stdio: ['ignore', 'ignore', 'ignore'],
    });
    const result = await new Promise((resolve, reject) => {
      child.once('error', reject);
      child.once('close', (code, signal) => {
        childClosed = true;
        resolve({ code, signal });
      });
    });
    const events = JSON.parse(readFileSync(faultEvents, 'utf8'));
    const dataDir = fault === 'writer-partial-init'
      ? events.writerDataDirs[0]
      : events.seedDataDirs.at(-1);
    if (dataDir && existsSync(path.dirname(dataDir)))
      retainedRoot = proveOwnedRetainedRoot(
        dataDir,
        fault === 'writer-partial-init' ? 'actual-writer' : 'seed-client',
      );
    return {
      result,
      events,
      report: JSON.parse(readFileSync(output, 'utf8')),
      retainedRoot: retainedRoot !== null,
      outputMode: statSync(output).mode & 0o777,
    };
  } finally {
    t.signal.removeEventListener('abort', onAbort);
    if (childClosed && retainedRoot) {
      rmSync(retainedRoot.root, { recursive: true, force: false });
      rmdirSync(retainedRoot.parent);
    }
    rmSync(artifacts, { recursive: true, force: true });
  }
}

test('seed SDK partial acquisition is shut down before a later shutdown failure retains the root',
  { timeout: 1200000 }, async (t) => {
    const result = await runCleanupReview(t, 'seed-lifecycle', '120,121,122');
    assert.equal(result.result.signal, null);
    assert.equal(result.result.code, 2);
    assert.deepEqual({
      seedInitAttempts: result.events.seedInitAttempts,
      seedInitAcquisitions: result.events.seedInitAcquisitions,
      seedInitFailures: result.events.seedInitFailures,
      seedShutdownCalls: result.events.seedShutdownCalls,
      seedShutdownFailures: result.events.seedShutdownFailures,
      harnessSeedFinalizations: result.events.harnessSeedFinalizations,
      writerOpenCount: result.events.writerDataDirs.length,
      retainedRoot: result.retainedRoot,
      childProcessesClosed: result.events.childProcessesStarted >= 4 &&
        result.events.childProcessesClosed === result.events.childProcessesStarted,
      outputMode: result.outputMode,
      reportStatus: result.report.status,
      datasets: result.report.datasets.map(({ status, cleanupStatus, failureCode }) =>
        ({ status, cleanupStatus, failureCode })),
    }, {
      seedInitAttempts: 2,
      seedInitAcquisitions: 2,
      seedInitFailures: 1,
      seedShutdownCalls: 2,
      seedShutdownFailures: 1,
      harnessSeedFinalizations: 0,
      writerOpenCount: 0,
      retainedRoot: true,
      childProcessesClosed: true,
      outputMode: 0o600,
      reportStatus: 'unproven',
      datasets: [
        { status: 'failed', cleanupStatus: 'completed', failureCode: 'runtime_error' },
        { status: 'failed', cleanupStatus: 'unproven', failureCode: 'cleanup_unproven' },
        { status: 'unproven', cleanupStatus: 'unproven', failureCode: 'not_attempted_cleanup_unproven' },
      ],
    });
  });

test('partial Actual writer acquisition with failed shutdown retains its owned root and prevents another dataset',
  { timeout: 1200000 }, async (t) => {
    const result = await runCleanupReview(t, 'writer-partial-init', '120,121');
    assert.equal(result.result.signal, null);
    assert.equal(result.result.code, 2);
    assert.deepEqual({
      writerInitFailures: result.events.writerInitFailures,
      writerShutdownFailures: result.events.writerShutdownFailures,
      writerOpenCount: result.events.writerDataDirs.length,
      retainedRoot: result.retainedRoot,
      childProcessesClosed: result.events.childProcessesStarted >= 2 &&
        result.events.childProcessesClosed === result.events.childProcessesStarted,
      outputMode: result.outputMode,
      reportStatus: result.report.status,
      datasets: result.report.datasets.map(({ status, cleanupStatus, failureCode }) =>
        ({ status, cleanupStatus, failureCode })),
    }, {
      writerInitFailures: 1,
      writerShutdownFailures: 1,
      writerOpenCount: 1,
      retainedRoot: true,
      childProcessesClosed: true,
      outputMode: 0o600,
      reportStatus: 'unproven',
      datasets: [
        { status: 'failed', cleanupStatus: 'unproven', failureCode: 'cleanup_unproven' },
        { status: 'unproven', cleanupStatus: 'unproven', failureCode: 'not_attempted_cleanup_unproven' },
      ],
    });
  });
