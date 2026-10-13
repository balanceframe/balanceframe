import { createHash } from 'node:crypto';
import { closeSync, constants, createReadStream, existsSync, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createOwnedScenarioRoot, discardOwnedScenarioRoot, readScenarioProcessMemory, startScenarioShell, stopScenarioProcesses } from '../../packages/scenario-kit/dist/scenario-kit/src/process-runtime.js';
import { captureReviewScreenshot, closeOwnedChromium, closeReviewPage, createReviewPage, performSync, startOwnedChromium } from './review-browser.mjs';

const SCRIPT = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(SCRIPT), '../..');
const scenarioKitRequire = createRequire(path.join(ROOT, 'packages/scenario-kit/package.json'));
const loadScenarioOwnedPackage = (specifier) =>
  import(pathToFileURL(scenarioKitRequire.resolve(specifier)).href);
const loadScenarioOwnedFile = (relativePath) =>
  import(pathToFileURL(path.join(ROOT, relativePath)).href);
let activeActualFetchSignal = null;
const nativeActualFetch = globalThis.fetch;
const actualFetchBridge = (input, init) => {
  if (activeActualFetchSignal === null) return nativeActualFetch.call(globalThis, input, init);
  const signals = [activeActualFetchSignal];
  if (init?.signal && !signals.includes(init.signal)) signals.push(init.signal);
  if (typeof Request === 'function' && input instanceof Request && input.signal && !signals.includes(input.signal))
    signals.push(input.signal);
  const signal = signals.length === 1 ? signals[0] : AbortSignal.any(signals);
  return nativeActualFetch.call(globalThis, input, { ...init, signal });
};
let actualApi;
globalThis.fetch = actualFetchBridge;
try {
  actualApi = await loadScenarioOwnedPackage('@actual-app/api');
} finally {
  globalThis.fetch = nativeActualFetch;
}
const [workflowStore, scenarioCatalog, scenarioLoader, workflowSetup] = await Promise.all([
  loadScenarioOwnedPackage('@balanceframe/workflow-store'),
  loadScenarioOwnedPackage('@balanceframe/scenario-kit/catalog'),
  loadScenarioOwnedPackage('@balanceframe/scenario-kit/loader'),
  loadScenarioOwnedFile('packages/scenario-kit/dist/scenario-kit/src/workflow-setup.js'),
]);
const { SqliteWorkflowStore } = workflowStore;
const { materializeScenario } = scenarioCatalog;
const { builtWebEntry, initializeScenarioShell } = scenarioLoader;
const { ScenarioHttpClient } = workflowSetup;

/** Scopes a single sequential Actual SDK dataset to its caller's abort signal. */
export async function withActualFetchSignal(signal, operation) {
  if (!signal || typeof signal.aborted !== 'boolean' || typeof signal.addEventListener !== 'function' ||
    typeof operation !== 'function' || activeActualFetchSignal !== null)
    throw new Error('actual_abort_context_invalid');
  activeActualFetchSignal = signal;
  try { return await operation(); } finally { activeActualFetchSignal = null; }
}
/** Enforces a deadline over dataset setup, measurements, and awaited cleanup. */
export async function withDatasetDeadline(timeoutMs, externalSignal, operation) {
  const controller = new AbortController();
  const deadlineAt = performance.now() + timeoutMs;
  let deadlineExpired = false;
  const onExternalAbort = () => controller.abort();
  if (externalSignal?.aborted) controller.abort();
  else externalSignal?.addEventListener('abort', onExternalAbort, { once: true });
  const timer = setTimeout(() => {
    deadlineExpired = true;
    controller.abort();
  }, timeoutMs);
  try {
    return await operation({ signal: controller.signal, deadlineAt, deadlineExpired: () => deadlineExpired });
  } finally {
    clearTimeout(timer);
    externalSignal?.removeEventListener('abort', onExternalAbort);
  }
}
const SCENARIO_ID = 'merchant-local-sparse';
const SCENARIO_DATE = '2026-10-04';
const SCENARIO_ANCHOR = new Date(`${SCENARIO_DATE}T12:00:00.000Z`);
const MAX_SOURCE_ROWS = 250000;
const UI_QUEUE_MAX = 50;
const ACTUAL_BATCH_SIZE = 500;
const NATIVE_MEMORY_LIMIT_BYTES = 512 * 1024 * 1024;
const MEMORY_SCOPE = 'owned Actual and web entry processes only; prepared-state baseline through first population, warmups, and repeated Sync; excludes descendants, browser, and host';
const FAILURE_CODES = new Set([
  'dataset_deadline_exceeded', 'deadline_exceeded', 'scenario_setup_failed', 'identity_unverified',
  'source_admission_unproven', 'source_below_requested_size', 'actual_import_unproven', 'source_grant_unavailable',
  'source_queue_invariant_failed', 'review_page_failed', 'review_sync_failed', 'review_ui_unproven',
  'review_sync_control_unavailable', 'review_sync_http_or_envelope_failed',
  'review_sync_partial_transition', 'review_sync_already_active',
  'review_screenshot_unavailable', 'signal_interrupted', 'runtime_error', 'origin_guard_unproven',
  'cleanup_unproven', 'not_attempted_cleanup_unproven',
]);

const fail = (code) => { const error = new Error(code); error.code = code; throw error; };
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

function positiveInteger(value, flag, maximum) {
  if (!/^[1-9]\d*$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) > maximum)
    throw new Error(`${flag}_invalid`);
  return Number(value);
}

/** Parses and bounds the runner's source sizes, timing, browser, and artifact controls. */
export function parseArgs(args) {
  const options = {
    sizes: [50000, 250000], warmups: 2, iterations: 20, deadlineMs: 30000,
    datasetDeadlineMs: 3600000, chromiumPath: '/opt/google/chrome/chrome', output: null, help: false,
  };
  const valueFlags = new Map([
    ['--sizes', 'sizes'], ['--warmups', 'warmups'], ['--iterations', 'iterations'], ['--deadline-ms', 'deadlineMs'],
    ['--dataset-deadline-ms', 'datasetDeadlineMs'], ['--chromium-path', 'chromiumPath'], ['--output', 'output'],
  ]);
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    if (flag === '--help') { options.help = true; continue; }
    const key = valueFlags.get(flag);
    if (!key) throw new Error('unknown_argument');
    const value = args[++index];
    if (typeof value !== 'string' || value.length === 0 || value.startsWith('--')) throw new Error('argument_value_missing');
    if (key === 'sizes') {
      const sizes = value.split(',').map((part) => positiveInteger(part, flag, MAX_SOURCE_ROWS));
      if (new Set(sizes).size !== sizes.length || sizes.some((size, position) => position > 0 && size <= sizes[position - 1]))
        throw new Error('sizes_invalid');
      options.sizes = sizes;
    } else if (key === 'warmups') options.warmups = positiveInteger(value, flag, 100);
    else if (key === 'iterations') options.iterations = positiveInteger(value, flag, 1000);
    else if (key === 'deadlineMs') options.deadlineMs = positiveInteger(value, flag, 3600000);
    else if (key === 'datasetDeadlineMs') options.datasetDeadlineMs = positiveInteger(value, flag, 86400000);
    else if (key === 'chromiumPath') options.chromiumPath = path.resolve(value);
    else options.output = path.resolve(value);
  }
  if (!options.help && !options.output) throw new Error('output_required');
  return options;
}

function valueAsBigInt(value, label) {
  let result;
  try { result = BigInt(value); } catch { throw new Error(`${label}_invalid`); }
  if (result < -BigInt(Number.MAX_SAFE_INTEGER) || result > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error(`${label}_unsafe`);
  return result;
}

function civilDateMilliseconds(date, label) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number(date.slice(0, 4)) < 1)
    throw new Error(`${label}_invalid`);
  const milliseconds = Date.parse(`${date}T00:00:00.000Z`);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString().slice(0, 10) !== date)
    throw new Error(`${label}_invalid`);
  return milliseconds;
}

function fiveYearAnalysisWindow(asOfDate) {
  const start = new Date(civilDateMilliseconds(asOfDate, 'as_of_date'));
  start.setUTCFullYear(start.getUTCFullYear() - 5);
  const analysisStartDate = start.toISOString().slice(0, 10);
  if (start.getUTCFullYear() < 1 || !/^\d{4}-\d{2}-\d{2}$/.test(analysisStartDate))
    throw new Error('analysis_horizon_unrepresentable');
  return { analysisStartDate, analysisEndDate: asOfDate };
}

/** Builds deterministic categorized USD history inside the source's current analysis window. */
export function buildTransactions(seed, size, actualIds) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_ROWS) throw new Error('size_invalid');
  if (!plainObject(seed) || !Array.isArray(seed.transactions) || typeof seed.snapshotDate !== 'string')
    throw new Error('canonical_seed_invalid');
  if (!Array.isArray(seed.accounts) || seed.accounts.length === 0 ||
    seed.accounts.some((account) => account.clearedBalance?.currency !== 'USD' ||
      account.importedBalance?.currency !== 'USD') ||
    seed.transactions.some((transaction) => transaction.amount?.currency !== 'USD'))
    throw new Error('canonical_usd_fixture_required');
  if (!plainObject(actualIds) || ['accountId', 'payeeId', 'categoryId'].some((key) =>
    typeof actualIds[key] !== 'string' || actualIds[key].length === 0)) throw new Error('actual_mapping_invalid');
  const fixtureDate = civilDateMilliseconds(seed.snapshotDate.slice(0, 10), 'snapshot_date');
  const analysisStart = civilDateMilliseconds(actualIds.analysisStartDate, 'analysis_start_date');
  const analysisEnd = civilDateMilliseconds(actualIds.analysisEndDate, 'analysis_end_date');
  const historicalEnd = Math.min(analysisEnd, fixtureDate);
  if (analysisStart > historicalEnd) throw new Error('actual_horizon_invalid');
  const dayCount = Math.floor((historicalEnd - analysisStart) / 86400000) + 1;
  const sourceImportedIds = new Set(seed.transactions.map((row) => row.importedId).filter((id) => typeof id === 'string'));
  const namespace = String(actualIds.importPrefix ?? size).replace(/[^A-Za-z0-9_-]/g, '').slice(0, 32);
  const rows = [];
  let generatedTotal = 0n;
  for (let index = 0; index < size; index += 1) {
    const importedId = `bf-review-${namespace}-${String(index).padStart(6, '0')}`;
    if (sourceImportedIds.has(importedId)) throw new Error('generated_import_id_collision');
    const amount = -100 - ((index * 7919) % 4901);
    if (!Number.isSafeInteger(amount) || amount >= 0 || amount < -10000) throw new Error('generated_amount_invalid');
    generatedTotal += BigInt(amount);
    const date = new Date(analysisStart + (index % dayCount) * 86400000).toISOString().slice(0, 10);
    rows.push({
      date, amount, payee: actualIds.payeeId, category: actualIds.categoryId, notes: '', cleared: true,
      imported_id: importedId, imported_payee: 'Synthetic categorized history',
    });
  }
  if (new Set(rows.map((row) => row.imported_id)).size !== rows.length) throw new Error('generated_import_id_collision');
  const balance = actualIds.initialBalanceMinorUnits === undefined ? 0n : valueAsBigInt(actualIds.initialBalanceMinorUnits, 'initial_balance');
  const projectedBalance = balance + generatedTotal;
  if (projectedBalance < -BigInt(Number.MAX_SAFE_INTEGER) || projectedBalance > BigInt(Number.MAX_SAFE_INTEGER))
    throw new Error('projected_balance_unsafe');
  return rows;
}

function uniqueIds(value, label) {
  if (!Array.isArray(value) || value.some((id) => typeof id !== 'string' || id.length === 0))
    throw new Error(`${label}_invalid`);
  if (new Set(value).size !== value.length) throw new Error(`${label}_duplicate`);
  return value;
}

function assertSameIdSet(expected, observed, label) {
  const left = [...uniqueIds(expected, `${label}_expected`)].sort();
  const right = [...uniqueIds(observed, `${label}_observed`)].sort();
  if (left.length !== right.length || left.some((id, index) => id !== right[index]))
    throw new Error(`${label}_mismatch`);
  return left.length;
}

/** Verifies the unchanged baseline facts and exact generated delta in one native readback. */
function assertFinancialReadback(expected, observed) {
  const { baselineRows, baselineBalances, appendAccountId, generatedMinorUnits } = expected ?? {};
  const { rows, balances } = observed ?? {};
  if (!Array.isArray(baselineRows) || !Array.isArray(rows) || !(baselineBalances instanceof Map) ||
    !(balances instanceof Map) || typeof appendAccountId !== 'string' ||
    typeof generatedMinorUnits !== 'bigint')
    throw new Error('actual_import_readback_mismatch');

  const baselineById = new Map();
  for (const row of baselineRows) {
    if (!plainObject(row) || typeof row.id !== 'string' || typeof row.accountId !== 'string' ||
      !Number.isSafeInteger(row.amount) || baselineById.has(row.id))
      throw new Error('actual_import_readback_mismatch');
    baselineById.set(row.id, row);
  }
  if (!baselineBalances.has(appendAccountId) || baselineBalances.size !== balances.size)
    throw new Error('actual_balance_readback_mismatch');
  const nativeFields = ['accountId', 'amount', 'date', 'payee', 'category', 'imported_id',
    'imported_payee', 'notes', 'cleared', 'reconciled', 'parent_id', 'transfer_id', 'is_parent'];
  for (const row of rows) {
    if (!plainObject(row)) throw new Error('actual_import_readback_mismatch');
    const baseline = baselineById.get(row.id);
    if (baseline) {
      for (const field of nativeFields)
        if (row[field] !== baseline[field]) throw new Error('actual_import_readback_mismatch');
      baselineById.delete(row.id);
    }
  }
  if (baselineById.size) throw new Error('actual_import_readback_mismatch');
  for (const [id, before] of baselineBalances) {
    const after = balances.get(id);
    if (!Number.isSafeInteger(before) || !Number.isSafeInteger(after))
      throw new Error('actual_balance_readback_mismatch');
    const expectedAfter = BigInt(before) + (id === appendAccountId ? generatedMinorUnits : 0n);
    if (expectedAfter < -BigInt(Number.MAX_SAFE_INTEGER) || expectedAfter > BigInt(Number.MAX_SAFE_INTEGER) ||
      after !== Number(expectedAfter))
      throw new Error('actual_balance_readback_mismatch');
  }
}

/** Verifies source/queue identity, supplied native financial facts and canonical fixture proof. */
export function assertSourceQueueSnapshot(expected, observed) {
  if (!plainObject(expected) || !plainObject(observed)) throw new Error('snapshot_invalid');
  const sourceCount = assertSameIdSet(expected.sourceIds, observed.sourceIds, 'source_ids');
  const queueCount = assertSameIdSet(expected.queueIds, observed.queueIds, 'queue_ids');
  if (expected.canonicalQueueIds !== undefined)
    assertSameIdSet(expected.canonicalQueueIds, expected.queueIds, 'canonical_queue_ids');
  if (expected.currentItem !== undefined || observed.currentItem !== undefined) {
    const fields = ['transactionId', 'accountId', 'amount', 'currency', 'originalImportedName', 'nativeImportedName'];
    const expectedItem = expected.currentItem;
    const observedItem = observed.currentItem;
    if (!plainObject(expectedItem) || !plainObject(observedItem) ||
      typeof expectedItem.transactionId !== 'string' || !expectedItem.transactionId ||
      typeof expectedItem.accountId !== 'string' || !expectedItem.accountId ||
      !Number.isSafeInteger(expectedItem.amount) || typeof expectedItem.currency !== 'string' ||
      !expectedItem.currency || typeof expectedItem.originalImportedName !== 'string' ||
      !expectedItem.originalImportedName || typeof expectedItem.nativeImportedName !== 'string' ||
      !expectedItem.nativeImportedName || fields.some((field) => expectedItem[field] !== observedItem[field]))
      throw new Error('fixture_current_item_mismatch');
  }
  if (expected.financial !== undefined || observed.financial !== undefined)
    assertFinancialReadback(expected.financial, observed.financial);
  return { sourceCount, queueCount };
}

function observationWindowKey(observation) {
  if (!plainObject(observation)) return null;
  try {
    const captureStart = civilDateMilliseconds(observation.captureStartDate, 'capture_start_date');
    const captureEnd = civilDateMilliseconds(observation.captureEndDate, 'capture_end_date');
    civilDateMilliseconds(observation.analysisStartDate, 'analysis_start_date');
    civilDateMilliseconds(observation.analysisEndDate, 'analysis_end_date');
    const expected = fiveYearAnalysisWindow(observation.asOfDate);
    if (captureStart > captureEnd || observation.analysisStartDate !== expected.analysisStartDate ||
      observation.analysisEndDate !== expected.analysisEndDate) return null;
    return [observation.asOfDate, observation.captureStartDate, observation.captureEndDate,
      observation.analysisStartDate, observation.analysisEndDate].join('\u0000');
  } catch { return null; }
}

function validObservation(observation, size) {
  return plainObject(observation) && observation.status === 'completed' && observation.censored === false &&
    Number.isFinite(observation.elapsedMs) && observation.elapsedMs >= 0 && observation.uiSettled === true &&
    observation.sourceQueueStable === true && observation.sourceCount === size &&
    observation.originalSourceCount === size && observation.truncatedCount === 0 &&
    Number.isSafeInteger(observation.queueCount) && observation.queueCount >= 0 && observation.queueCount <= UI_QUEUE_MAX &&
    observationWindowKey(observation) !== null;
}

function nearestRank95(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1];
}

/** Returns descriptive warmed-repeat p95 only for a complete, exact-source reference. */
export function aggregate({ size, warmups, samples }) {
  if (!Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_ROWS) throw new Error('size_invalid');
  const warmupList = Array.isArray(warmups) ? warmups : [];
  const sampleList = Array.isArray(samples) ? samples : [];
  const observations = [...warmupList, ...sampleList];
  const queueCounts = observations.map((sample) => sample?.queueCount);
  const oneStableQueue = queueCounts.length > 0 && queueCounts.every((count) =>
    Number.isSafeInteger(count) && count === queueCounts[0]);
  const windowKeys = observations.map(observationWindowKey);
  const oneAnalysisWindow = windowKeys.length > 0 &&
    windowKeys.every((key) => key !== null && key === windowKeys[0]);
  const allValid = observations.every((sample) => validObservation(sample, size));
  const complete = warmupList.length === 2 && sampleList.length === 20 && allValid && oneStableQueue && oneAnalysisWindow;
  const completedWarmups = warmupList.filter((sample) => validObservation(sample, size)).length;
  const completedSamples = sampleList.filter((sample) => validObservation(sample, size)).length;
  const censoredSamples = sampleList.filter((sample) => sample?.censored === true || sample?.status === 'timeout').length;
  const p95ElapsedMs = complete ? nearestRank95(sampleList.map((sample) => sample.elapsedMs)) : null;
  return {
    requestedWarmups: 2, completedWarmups, attemptedSamples: sampleList.length, completedSamples,
    failedSamples: sampleList.length - completedSamples - censoredSamples, censoredSamples,
    queueCount: oneStableQueue ? queueCounts[0] : null, p95ElapsedMs,
    referenceStatus: complete ? 'descriptive' : 'unproven', uiThresholdMs: null,
  };
}
function validMemoryReading(value) {
  return plainObject(value) && Number.isSafeInteger(value.rssBytes) && value.rssBytes >= 0 &&
    Number.isSafeInteger(value.highWaterBytes) && value.highWaterBytes >= 0;
}

/** Summarizes approximate owned-process RSS/HWM readings without retaining process identifiers. */
export function summarizeProcessMemory({ baseline, ending, samples, failedReads }) {
  const sampleList = Array.isArray(samples) ? samples : [];
  const safeFailedReads = Number.isSafeInteger(failedReads) && failedReads >= 0 ? failedReads : 1;
  let incomplete = safeFailedReads > 0 || sampleList.length === 0 || !Array.isArray(samples);
  const summarizeProcess = (kind) => {
    const start = validMemoryReading(baseline?.[kind]) ? {
      rssBytes: baseline[kind].rssBytes, highWaterBytes: baseline[kind].highWaterBytes,
    } : null;
    const end = validMemoryReading(ending?.[kind]) ? {
      rssBytes: ending[kind].rssBytes, highWaterBytes: ending[kind].highWaterBytes,
    } : null;
    if (!start || !end) {
      incomplete = true;
      return null;
    }
    let sampledPeakRssBytes = Math.max(start.rssBytes, end.rssBytes);
    for (const sample of sampleList) {
      const reading = validMemoryReading(sample?.[kind]) ? sample[kind] : null;
      if (!reading) {
        incomplete = true;
        continue;
      }
      sampledPeakRssBytes = Math.max(sampledPeakRssBytes, reading.rssBytes);
    }
    const lifetimeHighWaterDeltaBytes = end.highWaterBytes >= start.highWaterBytes
      ? end.highWaterBytes - start.highWaterBytes : null;
    if (lifetimeHighWaterDeltaBytes === null) incomplete = true;
    return {
      baseline: start, ending: end, sampledPeakRssBytes,
      sampledPeakRssDeltaBytes: Math.max(0, sampledPeakRssBytes - start.rssBytes),
      lifetimeHighWaterDeltaBytes,
    };
  };
  const actual = summarizeProcess('actual');
  const web = summarizeProcess('web');
  const observedCount = Number(actual !== null) + Number(web !== null);
  const state = observedCount === 2 && !incomplete ? 'observed' : observedCount > 0 ? 'partial' : 'unproven';
  return {
    state, approximate: true, scope: MEMORY_SCOPE, sampleCount: sampleList.length,
    failedReads: safeFailedReads, actual, web,
    reason: state === 'observed' ? null : state === 'partial'
      ? 'owned_process_memory_incomplete' : 'owned_process_memory_unavailable',
  };
}

const REPORT_FIELDS = new Set(['schemaVersion', 'benchmark', 'measuredAt', 'status', 'configuration', 'runtime', 'inputs', 'nativeGates', 'datasets']);
const OBJECT_FIELDS = {
  configuration: new Set(['scenarioId', 'scenarioDate', 'sizes', 'warmups', 'iterations', 'deadlineMs', 'datasetDeadlineMs', 'generatedLoad', 'measurementLabel']),
  runtime: new Set(['node', 'platform', 'architecture', 'kernel', 'cpuAffinity', 'allowedCpuCount', 'chromiumVersion', 'chromiumExecutableSha256', 'nativeAddonSha256', 'webEntrySha256', 'harnessSha256', 'browserHarnessSha256', 'scenarioFixtureSha256', 'benchmarkSpecSha256']),
  inputs: new Set(['scenarioId', 'sourceDate', 'generatedLoad', 'qualityLabels', 'mappingVersion', 'sourceCap', 'queueCap']),
  nativeGates: new Set(['latency50kMs', 'latency250kMs', 'memoryLimitBytes', 'source']),
  queue: new Set(['count', 'persistedCount', 'visibleCount', 'maximumUiCount', 'idsSha256', 'stable']),
  money: new Set(['currency', 'generatedMinorUnits', 'accountBalanceBeforeMinorUnits', 'accountBalanceAfterMinorUnits', 'balanceCheck']),
  dataset: new Set(['size', 'status', 'cleanupStatus', 'failureCode', 'identityFingerprint', 'chromiumVersion', 'preparationElapsedMs', 'batchSize', 'batchCount', 'generatedHistoryCount', 'grantsProvisioned', 'actualReadbackMs', 'independentCaptureMs', 'originGuardStatus', 'originGuardQueueUnchanged', 'source', 'queue', 'money', 'firstPopulation', 'warmups', 'samples', 'completedWarmups', 'attemptedSamples', 'completedSamples', 'failedSamples', 'censoredSamples', 'p95ElapsedMs', 'referenceStatus', 'uiThresholdMs', 'memory', 'uiProof']),
  source: new Set(['count', 'originalCount', 'retainedCount', 'truncatedCount', 'rawActualRowCount', 'startingBalanceCount', 'splitParentCount', 'splitChildCount', 'excludedRawRowCount', 'baselineCount', 'appendHeadroom', 'generatedHistoryCount', 'eligibleCount', 'candidateCount', 'persistedCount', 'visibleCount', 'asOfDate', 'captureStartDate', 'captureEndDate', 'analysisStartDate', 'analysisEndDate', 'actualReadbackIdsSha256', 'exactReadback', 'independentPublishedCapture', 'collectionsComplete']),
  firstPopulation: new Set(['status', 'elapsedMs', 'sourceCount', 'candidateCount', 'persistedCount', 'visibleCount', 'queueCount', 'persistedAddedCount', 'persistedRemovedCount', 'httpStatusCounts', 'pageErrorCodes', 'pageErrorCounts', 'queueFingerprint', 'currentItemFingerprint']),
  observation: new Set(['status', 'censored', 'elapsedMs', 'uiSettled', 'sourceQueueStable', 'sourceCount', 'originalSourceCount', 'truncatedCount', 'queueCount', 'asOfDate', 'captureStartDate', 'captureEndDate', 'analysisStartDate', 'analysisEndDate', 'persistedAddedCount', 'persistedRemovedCount', 'httpStatusCounts', 'pageErrorCodes']),
  memory: new Set(['state', 'approximate', 'scope', 'sampleCount', 'failedReads', 'actual', 'web', 'reason']),
  processMemory: new Set(['baseline', 'ending', 'sampledPeakRssBytes', 'sampledPeakRssDeltaBytes',
    'lifetimeHighWaterDeltaBytes']),
  memoryReading: new Set(['rssBytes', 'highWaterBytes']),
  uiProof: new Set(['screenshotFileName', 'screenshotSha256', 'queueFingerprint', 'currentItemFingerprint', 'httpStatusCounts', 'pageErrorCodes', 'pageErrorCounts']),
  httpStatusCounts: new Set(['syncPost', 'reviewGet', 'categoriesGet']),
  pageErrorCounts: new Set(['network_error', 'runtime_exception', 'console_error']),
};

function validateObjectKeys(value, allowed, label) {
  if (!plainObject(value)) throw new Error(`${label}_invalid`);
  for (const key of Object.keys(value)) if (!allowed.has(key)) throw new Error('artifact_field_not_allowed');
}

function validateHash(value) {
  return typeof value === 'string' && /^sha256:[a-f0-9]{64}$/.test(value);
}

function validateStatusCounts(value) {
  validateObjectKeys(value, OBJECT_FIELDS.httpStatusCounts, 'http_status_counts');
  for (const endpoint of Object.keys(value)) {
    const statuses = value[endpoint];
    if (!plainObject(statuses)) throw new Error('http_status_counts_invalid');
    for (const [status, count] of Object.entries(statuses)) {
      if (!/^\d{3}$/.test(status) || !Number.isSafeInteger(count) || count < 0) throw new Error('http_status_counts_invalid');
    }
  }
}

function validatePageErrorCodes(value) {
  if (!Array.isArray(value) || value.some((code) => !['network_error', 'runtime_exception', 'console_error'].includes(code)))
    throw new Error('page_error_codes_invalid');
}
function validatePageErrorCounts(value) {
  validateObjectKeys(value, OBJECT_FIELDS.pageErrorCounts, 'page_error_counts');
  if (Object.values(value).some((count) => !Number.isSafeInteger(count) || count < 0))
    throw new Error('page_error_counts_invalid');
}

function validateArtifactObject(value, kind) {
  const allowed = kind === 'root' ? REPORT_FIELDS : OBJECT_FIELDS[kind];
  validateObjectKeys(value, allowed, kind);
  for (const [key, child] of Object.entries(value)) {
    if (child === null) continue;
    if ((kind === 'root' && key === 'datasets') ||
      (kind === 'dataset' && (key === 'samples' || key === 'warmups'))) {
      if (!Array.isArray(child)) throw new Error('artifact_array_invalid');
      const childKind = kind === 'root' ? 'dataset' : 'observation';
      for (const item of child) validateArtifactObject(item, childKind);
    } else if (kind === 'nativeGates' && key === 'source') {
      if (typeof child !== 'string') throw new Error('native_gate_source_invalid');
    } else if (kind === 'memory' && (key === 'actual' || key === 'web')) {
      if (child !== null) validateArtifactObject(child, 'processMemory');
    } else if (kind === 'processMemory' && (key === 'baseline' || key === 'ending')) {
      validateArtifactObject(child, 'memoryReading');
    } else if (key === 'configuration' || key === 'runtime' || key === 'inputs' || key === 'nativeGates' ||
      key === 'source' || key === 'queue' || key === 'money' || key === 'firstPopulation' || key === 'memory' || key === 'uiProof') {
      validateArtifactObject(child, key);
    } else if (key === 'httpStatusCounts') validateStatusCounts(child);
    else if (key === 'pageErrorCodes') validatePageErrorCodes(child);
    else if (key === 'pageErrorCounts') validatePageErrorCounts(child);
  }
  if (kind === 'root' && value.schemaVersion !== 1) throw new Error('artifact_schema_invalid');
  if (kind === 'configuration' &&
    (value.scenarioId !== SCENARIO_ID || value.scenarioDate !== SCENARIO_DATE ||
      !Array.isArray(value.sizes) || value.sizes.length === 0 || value.sizes.some((size, index) =>
        !Number.isSafeInteger(size) || size < 1 || size > MAX_SOURCE_ROWS || index > 0 && size <= value.sizes[index - 1]) ||
      !Number.isSafeInteger(value.warmups) || value.warmups < 1 || value.warmups > 100 ||
      !Number.isSafeInteger(value.iterations) || value.iterations < 1 || value.iterations > 1000 ||
      !Number.isSafeInteger(value.deadlineMs) || value.deadlineMs < 1 || value.deadlineMs > 3600000 ||
      !Number.isSafeInteger(value.datasetDeadlineMs) || value.datasetDeadlineMs < 1 ||
      value.datasetDeadlineMs > 86400000 ||
      typeof value.generatedLoad !== 'string' || typeof value.measurementLabel !== 'string'))
    throw new Error('configuration_invalid');
  if (kind === 'uiProof') {
    if (typeof value.screenshotFileName !== 'string' || !/^[A-Za-z0-9_.-]+$/.test(value.screenshotFileName) ||
      !validateHash(value.screenshotSha256) || !validateHash(value.queueFingerprint) || !validateHash(value.currentItemFingerprint))
      throw new Error('ui_proof_invalid');
    validateStatusCounts(value.httpStatusCounts);
    validatePageErrorCodes(value.pageErrorCodes);
    validatePageErrorCounts(value.pageErrorCounts);
  }
  if (kind === 'observation') {
    if (typeof value.status !== 'string' || !['completed', 'timeout', 'error'].includes(value.status) ||
      typeof value.censored !== 'boolean' || (value.elapsedMs !== null && (!Number.isFinite(value.elapsedMs) || value.elapsedMs < 0)) ||
      observationWindowKey(value) === null) throw new Error('observation_invalid');
    validateStatusCounts(value.httpStatusCounts);
    validatePageErrorCodes(value.pageErrorCodes);
  }
  if (kind === 'firstPopulation') {
    if (typeof value.status !== 'string' || !['completed', 'unproven'].includes(value.status) ||
      (value.elapsedMs !== null && (!Number.isFinite(value.elapsedMs) || value.elapsedMs < 0)) ||
      (value.queueFingerprint !== null && !validateHash(value.queueFingerprint)) ||
      (value.currentItemFingerprint !== null && !validateHash(value.currentItemFingerprint)))
      throw new Error('first_population_invalid');
    validateStatusCounts(value.httpStatusCounts);
    validatePageErrorCodes(value.pageErrorCodes);
    validatePageErrorCounts(value.pageErrorCounts);
  }
  if (kind === 'dataset') {
    if (!Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_SOURCE_ROWS ||
      !['completed', 'unproven', 'failed'].includes(value.status)) throw new Error('dataset_invalid');
    if (!['completed', 'unproven'].includes(value.cleanupStatus) ||
      value.status === 'completed' && value.cleanupStatus !== 'completed' ||
      value.failureCode === 'cleanup_unproven' && value.cleanupStatus !== 'unproven')
      throw new Error('cleanup_status_invalid');
    if (value.failureCode !== undefined && value.failureCode !== null && !FAILURE_CODES.has(value.failureCode))
      throw new Error('failure_code_invalid');
    if (value.identityFingerprint !== undefined && value.identityFingerprint !== null && !validateHash(value.identityFingerprint))
      throw new Error('identity_fingerprint_invalid');
    if (value.uiThresholdMs !== null) throw new Error('ui_threshold_not_allowed');
    if (!Object.hasOwn(value, 'originGuardStatus') || !Object.hasOwn(value, 'originGuardQueueUnchanged') ||
      (value.originGuardStatus !== null && (!Number.isSafeInteger(value.originGuardStatus) ||
        value.originGuardStatus < 100 || value.originGuardStatus > 599)) ||
      (value.originGuardQueueUnchanged !== null && typeof value.originGuardQueueUnchanged !== 'boolean'))
      throw new Error('origin_guard_invalid');
    if (value.status === 'completed' &&
      (value.originGuardStatus !== 403 || value.originGuardQueueUnchanged !== true))
      throw new Error('origin_guard_unproven');
  }
  if (kind === 'nativeGates' && (value.latency50kMs !== 2000 || value.latency250kMs !== 5000 ||
    value.memoryLimitBytes !== NATIVE_MEMORY_LIMIT_BYTES || typeof value.source !== 'string'))
    throw new Error('native_gate_values_invalid');
  if (kind === 'source') {
    for (const key of ['count', 'originalCount', 'retainedCount', 'truncatedCount', 'rawActualRowCount', 'startingBalanceCount',
      'splitParentCount', 'splitChildCount', 'excludedRawRowCount', 'baselineCount', 'appendHeadroom', 'generatedHistoryCount',
      'eligibleCount', 'candidateCount', 'persistedCount', 'visibleCount']) {
      const number = value[key];
      if (number !== null && number !== undefined && (!Number.isSafeInteger(number) || number < 0)) throw new Error('source_metric_invalid');
    }
    const dateKeys = ['asOfDate', 'captureStartDate', 'captureEndDate', 'analysisStartDate', 'analysisEndDate'];
    if (dateKeys.some((key) => !Object.hasOwn(value, key))) throw new Error('source_date_invalid');
    const dates = dateKeys.map((key) => value[key]);
    if (dates.some((date) => date === null) && dates.some((date) => date !== null))
      throw new Error('source_date_invalid');
    if (dates.every((date) => date !== null)) {
      for (const [index, key] of dateKeys.entries()) civilDateMilliseconds(dates[index], key);
      const expected = fiveYearAnalysisWindow(value.asOfDate);
      if (value.captureStartDate > value.captureEndDate || value.analysisStartDate !== expected.analysisStartDate ||
        value.analysisEndDate !== expected.analysisEndDate) throw new Error('source_date_invalid');
    }
    if (value.actualReadbackIdsSha256 !== undefined && value.actualReadbackIdsSha256 !== null &&
      !validateHash(value.actualReadbackIdsSha256)) throw new Error('source_fingerprint_invalid');
  }
  if (kind === 'queue' && value.idsSha256 !== undefined && value.idsSha256 !== null && !validateHash(value.idsSha256))
    throw new Error('queue_fingerprint_invalid');
  if (kind === 'memory') {
    const observedProcesses = Number(plainObject(value.actual)) + Number(plainObject(value.web));
    if (!['observed', 'partial', 'unproven'].includes(value.state) || value.approximate !== true ||
      value.scope !== MEMORY_SCOPE || !Number.isSafeInteger(value.sampleCount) || value.sampleCount < 0 ||
      !Number.isSafeInteger(value.failedReads) || value.failedReads < 0 ||
      ![null, 'owned_process_memory_incomplete', 'owned_process_memory_unavailable'].includes(value.reason) ||
      !Object.hasOwn(value, 'actual') || !Object.hasOwn(value, 'web') ||
      (value.state === 'observed' && (observedProcesses !== 2 || value.sampleCount === 0 ||
        value.failedReads !== 0 || value.reason !== null)) ||
      (value.state === 'partial' && (observedProcesses === 0 || value.reason !== 'owned_process_memory_incomplete')) ||
      (value.state === 'unproven' && (observedProcesses !== 0 || value.reason !== 'owned_process_memory_unavailable')))
      throw new Error('memory_state_invalid');
  }
  if (kind === 'memoryReading' && !validMemoryReading(value)) throw new Error('memory_reading_invalid');
  if (kind === 'processMemory') {
    if (!validMemoryReading(value.baseline) || !validMemoryReading(value.ending))
      throw new Error('memory_reading_invalid');
    for (const key of ['sampledPeakRssBytes', 'sampledPeakRssDeltaBytes', 'lifetimeHighWaterDeltaBytes']) {
      const number = value[key];
      if (number !== null && (!Number.isSafeInteger(number) || number < 0)) throw new Error('memory_metric_invalid');
      if (key !== 'lifetimeHighWaterDeltaBytes' && number === null) throw new Error('memory_metric_invalid');
    }
  }
}

/** Serializes only whitelisted measurement fields and validates their bounded values. */
export function serializeArtifact(report) {
  validateArtifactObject(report, 'root');
  return `${JSON.stringify(report, null, 2)}\n`;
}

function assertNoSymlinkPath(absolutePath) {
  const root = path.parse(absolutePath).root;
  let cursor = root;
  for (const component of absolutePath.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, component);
    try {
      if (lstatSync(cursor).isSymbolicLink()) throw new Error('artifact_path_symlink');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      break;
    }
  }
}

function assertNewArtifactPath(filePath) {
  const absolute = path.resolve(filePath);
  assertNoSymlinkPath(absolute);
  const parent = path.dirname(absolute);
  const parentStat = lstatSync(parent);
  if (!parentStat.isDirectory() || parentStat.isSymbolicLink()) throw new Error('artifact_directory_invalid');
  if (existsSync(absolute)) throw new Error('artifact_already_exists');
  return absolute;
}

function writeExclusiveFile(filePath, bytes) {
  const absolute = assertNewArtifactPath(filePath);
  const descriptor = openSync(absolute, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  let open = true;
  let descriptorStat;
  try {
    fchmodSync(descriptor, 0o600);
    writeFileSync(descriptor, bytes);
    fsyncSync(descriptor);
    descriptorStat = fstatSync(descriptor);
    closeSync(descriptor);
    open = false;
    return absolute;
  } catch (error) {
    if (open) {
      try { descriptorStat = fstatSync(descriptor); } catch { /* Descriptor was already closed. */ }
      closeSync(descriptor);
    }
    try {
      const created = lstatSync(absolute);
      if (descriptorStat && !created.isSymbolicLink() && created.dev === descriptorStat.dev && created.ino === descriptorStat.ino)
        unlinkSync(absolute);
    } catch { /* Preserve any path replaced after creation. */ }
    throw error;
  }
}

/** Writes a serialized report to a new exclusive mode-0600 artifact path. */
export function writeArtifact(outputPath, report) {
  const text = serializeArtifact(report);
  return writeExclusiveFile(outputPath, text);
}

function writePrivateBytes(outputPath, bytes) {
  return writeExclusiveFile(outputPath, bytes);
}

function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(`sha256:${hash.digest('hex')}`));
  });
}

function getCpuAffinity() {
  if (process.platform !== 'linux') throw new Error('linux_required');
  const status = readFileSync('/proc/self/status', 'utf8');
  const affinity = /^Cpus_allowed_list:\s*(.+)$/m.exec(status)?.[1]?.trim();
  if (!affinity) throw new Error('cpu_affinity_unavailable');
  const allowedCpuCount = affinity.split(',').reduce((count, range) => {
    const [start, end = start] = range.split('-').map(Number);
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end < start) throw new Error('cpu_affinity_invalid');
    return count + end - start + 1;
  }, 0);
  if (allowedCpuCount !== 2) throw new Error('two_cpu_affinity_required');
  return { affinity, allowedCpuCount };
}

function boundedText(value, maximum = 160) {
  return String(value).replace(/[^A-Za-z0-9 ._:+/-]/g, '').slice(0, maximum);
}

function requireEnvelope(value) {
  if (!plainObject(value) || value.status !== 'ok' || !plainObject(value.result)) throw new Error('http_envelope_failed');
  return value.result;
}

/** Parses all-history capture coverage separately from the current five-year analysis horizon. */
export function sourceAdmission(result) {
  if (!plainObject(result) || !plainObject(result.sourceAdmission) || !plainObject(result.coverage))
    throw new Error('source_admission_unavailable');
  const admission = result.sourceAdmission;
  const accountCoverage = admission.accountCoverage;
  if (!Number.isSafeInteger(admission.originalTransactionCount) || admission.originalTransactionCount < 0 ||
    !Number.isSafeInteger(admission.truncatedCount) || admission.truncatedCount < 0 ||
    admission.truncatedCount > admission.originalTransactionCount ||
    !plainObject(admission.collections) || typeof admission.collections.transactions !== 'string' ||
    !Number.isSafeInteger(result.coverage.eligibleCount) || result.coverage.eligibleCount < 0 ||
    !Array.isArray(accountCoverage) || accountCoverage.length === 0 ||
    accountCoverage.some((coverage) => !plainObject(coverage) || coverage.state !== 'complete'))
    throw new Error('source_admission_invalid');
  for (const coverage of accountCoverage) {
    const start = civilDateMilliseconds(coverage.startDate, 'capture_start_date');
    const end = civilDateMilliseconds(coverage.endDate, 'capture_end_date');
    if (start > end) throw new Error('source_admission_invalid');
  }
  const windows = new Set(accountCoverage.map((coverage) => `${coverage.startDate}\u0000${coverage.endDate}`));
  if (windows.size !== 1) throw new Error('source_admission_invalid');
  const { asOfDate } = result;
  const { analysisStartDate, analysisEndDate } = fiveYearAnalysisWindow(asOfDate);
  const { startDate: captureStartDate, endDate: captureEndDate } = accountCoverage[0];
  return {
    sourceCount: admission.originalTransactionCount,
    originalSourceCount: admission.originalTransactionCount,
    retainedCount: admission.originalTransactionCount - admission.truncatedCount,
    truncatedCount: admission.truncatedCount,
    eligibleCount: result.coverage.eligibleCount,
    collectionsComplete: admission.collections.transactions === 'complete',
    asOfDate, captureStartDate, captureEndDate, analysisStartDate, analysisEndDate,
  };
}

function flattenActualRows(topRows) {
  if (!Array.isArray(topRows)) throw new Error('actual_transactions_unavailable');
  const rows = [];
  const visit = (candidate, parentId = null) => {
    if (!plainObject(candidate) || typeof candidate.id !== 'string' || candidate.id.length === 0)
      throw new Error('actual_transaction_id_unavailable');
    rows.push({ ...candidate, parentId });
    const children = Array.isArray(candidate.subtransactions) ? candidate.subtransactions : [];
    for (const child of children) visit(child, candidate.id);
  };
  for (const row of topRows) visit(row);
  if (new Set(rows.map((row) => row.id)).size !== rows.length) throw new Error('actual_transaction_id_duplicate');
  return rows;
}

/** Appends flattened SDK history, preserving native rows and each row's account identity. */
export function appendActualAccountRows(all, values, accountId) {
  if (!Array.isArray(values)) throw new Error('actual_transactions_unavailable');
  for (const row of flattenActualRows(values))
    all.push({ ...row, accountId: row.accountId ?? row.account ?? row.account_id ?? accountId });
}

async function actualRows(accountIds) {
  const all = [];
  for (const accountId of accountIds) {
    const values = await actualApi.getTransactions(accountId);
    appendActualAccountRows(all, values, accountId);
  }
  if (new Set(all.map((row) => row.id)).size !== all.length) throw new Error('actual_transaction_id_duplicate');
  return all;
}

async function actualBalances(accountIds) {
  const balances = new Map();
  for (const accountId of accountIds) {
    const balance = await actualApi.getAccountBalance(accountId);
    if (!Number.isSafeInteger(balance)) throw new Error('actual_balance_unavailable');
    balances.set(accountId, balance);
  }
  return balances;
}

function generatedRowMap(rows) {
  const map = new Map();
  for (const row of rows) map.set(row.imported_id, row);
  return map;
}

function verifyGeneratedReadback(rows, expectedRows, expectedAccountId) {
  const expectedByImport = generatedRowMap(expectedRows);
  if (expectedByImport.size !== expectedRows.length) throw new Error('generated_import_id_duplicate');
  const matches = rows.filter((row) => expectedByImport.has(row.imported_id));
  if (matches.length !== expectedRows.length) throw new Error('actual_import_readback_incomplete');
  const actualIds = [];
  const seen = new Set();
  for (const row of matches) {
    const expected = expectedByImport.get(row.imported_id);
    if (!expected || seen.has(row.imported_id) || row.accountId !== expectedAccountId || row.amount !== expected.amount ||
      row.payee !== expected.payee || row.category !== expected.category || row.date !== expected.date ||
      row.cleared !== true || row.tombstone === true || row._deleted === true || row.is_child === true)
      throw new Error('actual_import_readback_mismatch');
    seen.add(row.imported_id);
    actualIds.push(row.id);
  }
  if (seen.size !== expectedRows.length) throw new Error('actual_import_readback_incomplete');
  return actualIds;
}

function rawActualCounts(rows) {
  const startingBalanceCount = rows.filter((row) => row.starting_balance_flag === true || row.startingBalance === true).length;
  const splitParentCount = rows.filter((row) => row.is_parent === true || (Array.isArray(row.subtransactions) && row.subtransactions.length > 0)).length;
  const splitChildCount = rows.filter((row) => row.parentId !== null || row.is_child === true).length;
  return { rawActualRowCount: rows.length, startingBalanceCount, splitParentCount, splitChildCount };
}

function createPrivateDirectory(root, name) {
  const directory = path.join(root, name);
  mkdirSync(directory, { recursive: false, mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0) throw new Error('private_directory_invalid');
  return directory;
}

async function openActual(dataDir, processes, groupId) {
  try {
    const client = await actualApi.init({ serverURL: processes.actualUrl, password: processes.actualSecretKey, dataDir });
    await actualApi.downloadBudget(groupId);
    return client;
  } catch {
    try { await actualApi.shutdown(); } catch {
      const cleanupError = new Error('cleanup_unproven');
      cleanupError.code = 'cleanup_unproven';
      cleanupError.ownedCleanupUnproven = true;
      throw cleanupError;
    }
    throw new Error('actual_budget_download_failed');
  }
}

async function closeActual() {
  await actualApi.shutdown();
}

/** Compacts and republishes only the expected disposable budget, returning its rotated sync group. */
export async function publishActualSnapshot(client, expectedBudgetId) {
  const before = await client.send('load-prefs');
  const previousGroupId = before?.groupId;
  if (before?.cloudFileId !== expectedBudgetId || typeof previousGroupId !== 'string' || !previousGroupId)
    throw new Error('actual_budget_snapshot_identity_mismatch');
  const publication = await client.send('sync-reset');
  if (publication && typeof publication === 'object' && 'error' in publication && publication.error)
    throw new Error('actual_budget_snapshot_publication_failed');
  const after = await client.send('load-prefs');
  if (after?.cloudFileId !== expectedBudgetId || typeof after?.groupId !== 'string' ||
    !after.groupId || after.groupId === previousGroupId)
    throw new Error('actual_budget_snapshot_identity_mismatch');
  return after.groupId;
}

function pagesFromStore(store, budgetId, status) {
  return (async () => {
    const items = [];
    for (let offset = 0; ; offset += 500) {
      const page = await store.listReviewItems({ budgetId, status, limit: 500, offset });
      items.push(...page);
      if (page.length < 500) break;
    }
    return items;
  })();
}

async function readPersistedQueue(store, budgetId) {
  const pending = await pagesFromStore(store, budgetId, 'pending_review');
  const correcting = await pagesFromStore(store, budgetId, 'correcting');
  const items = [...pending, ...correcting];
  const ids = items.map((item) => item.transactionId);
  if (new Set(ids).size !== ids.length) throw new Error('persisted_queue_duplicate');
  return { ids, count: ids.length, pendingCount: pending.length, correctingCount: correcting.length };
}

function verifyIdentity(store, loaded, session) {
  const owner = loaded.initialized.personas.owner;
  if (!owner || session.actorId !== owner.actorId ||
    loaded.initialized.spaceId !== owner.spaceId || loaded.initialized.budgetId !== loaded.seeded.budgetId)
    throw new Error('identity_unverified');
  const now = new Date().toISOString();
  const space = store.governance.getSpace({ spaceId: loaded.initialized.spaceId });
  const budgetSpace = store.governance.getSpaceForBudget({ budgetId: loaded.seeded.budgetId });
  const membership = store.governance.getCurrentMembership({ spaceId: loaded.initialized.spaceId, actorId: owner.actorId, now });
  if (!space || space.deletedAt !== null || space.createdBy !== owner.actorId || space.budgetId !== loaded.seeded.budgetId ||
    !budgetSpace || budgetSpace.id !== space.id || budgetSpace.budgetId !== loaded.seeded.budgetId ||
    !membership || membership.id !== owner.membershipId || membership.actorId !== owner.actorId || membership.revokedAt !== null)
    throw new Error('identity_unverified');
  return {
    owner, identityFingerprint: `sha256:${sha256(JSON.stringify({ actorId: owner.actorId,
      spaceId: space.id, membershipId: membership.id, budgetId: loaded.seeded.budgetId }))}`,
  };
}

function provisionExactSourceGrants(store, loaded, owner, transactionIds, checkDeadline) {
  const now = new Date().toISOString();
  const space = store.governance.getSpace({ spaceId: loaded.initialized.spaceId });
  const membership = store.governance.getCurrentMembership({ spaceId: loaded.initialized.spaceId, actorId: owner.actorId, now });
  const bound = store.governance.getSpaceForBudget({ budgetId: loaded.seeded.budgetId });
  if (!space || !membership || membership.id !== owner.membershipId || space.createdBy !== owner.actorId ||
    space.budgetId !== loaded.seeded.budgetId || bound?.id !== space.id) throw new Error('source_grant_unavailable');
  let count = 0;
  for (const transactionId of transactionIds) {
    for (const capability of ['transaction.view', 'source']) {
      if (count % 1000 === 0) checkDeadline();
      const grant = store.governance.provisionResourceGrant({
        spaceId: space.id, actorId: owner.actorId, membershipId: membership.id, budgetId: loaded.seeded.budgetId,
        resourceKind: 'transaction', resourceId: transactionId, capability, granted: true, restrictions: {}, now,
      });
      if (!grant || grant.spaceId !== space.id || grant.membershipId !== membership.id ||
        grant.actorId !== owner.actorId || grant.budgetId !== loaded.seeded.budgetId ||
        grant.resourceKind !== 'transaction' || grant.resourceId !== transactionId ||
        grant.capability !== capability || grant.granted !== true || grant.revokedAt !== null)
        throw new Error('source_grant_unavailable');
      count += 1;
    }
  }
  return count;
}

function fingerprintIds(ids) {
  return `sha256:${sha256(JSON.stringify([...ids].sort()))}`;
}

function hashCurrentItem(item, expected) {
  const display = typeof item?.originalImportedName === 'string' ? item.originalImportedName.trim() : '';
  if (!item || typeof item.transactionId !== 'string' || !item.transactionId ||
    typeof item.normalizedMerchant !== 'string' || !display)
    throw new Error('current_item_fingerprint_unavailable');
  if (!display.toLowerCase().includes('aster atelier') || item.transactionId !== expected?.transactionId ||
    display !== expected?.originalImportedName || item.amount !== expected?.amount ||
    item.currency !== expected?.currency) throw new Error('fixture_current_item_mismatch');
  return `sha256:${sha256(JSON.stringify({
    transactionId: item.transactionId, normalizedMerchant: item.normalizedMerchant,
    originalImportedName: display, accountId: expected.accountId,
    amount: item.amount, currency: item.currency,
  }))}`;
}

function mergeStatusCounts(target, source) {
  for (const [endpoint, statuses] of Object.entries(source ?? {})) {
    target[endpoint] ??= {};
    for (const [status, count] of Object.entries(statuses ?? {})) target[endpoint][status] = (target[endpoint][status] ?? 0) + count;
  }
  return target;
}

function makeObservation(result, admission, queueCount, stable = true) {
  return {
    status: result?.status ?? 'error', censored: result?.censored === true,
    elapsedMs: Number.isFinite(result?.elapsedMs) ? result.elapsedMs : null,
    uiSettled: result?.uiSettled === true, sourceQueueStable: stable,
    sourceCount: admission.sourceCount, originalSourceCount: admission.originalSourceCount,
    truncatedCount: admission.truncatedCount, queueCount,
    asOfDate: admission.asOfDate, captureStartDate: admission.captureStartDate,
    captureEndDate: admission.captureEndDate, analysisStartDate: admission.analysisStartDate,
    analysisEndDate: admission.analysisEndDate,
    persistedAddedCount: Number.isSafeInteger(result?.persistedAddedCount) ? result.persistedAddedCount : 0,
    persistedRemovedCount: Number.isSafeInteger(result?.persistedRemovedCount) ? result.persistedRemovedCount : 0,
    httpStatusCounts: result?.httpStatusCounts ?? {}, pageErrorCodes: result?.pageErrorCodes ?? [],
  };
}

function browserFailureDiagnostics(error) {
  const diagnostics = error?.browserDiagnostics;
  const httpStatusCounts = {};
  const allowedEndpoints = ['syncPost', 'reviewGet', 'categoriesGet'];
  for (const endpoint of allowedEndpoints) {
    const statuses = diagnostics?.httpStatusCounts?.[endpoint];
    if (!plainObject(statuses)) continue;
    for (const [status, count] of Object.entries(statuses)) {
      if (/^\d{3}$/.test(status) && Number.isSafeInteger(count) && count > 0)
        (httpStatusCounts[endpoint] ??= {})[status] = Math.min(100, count);
    }
  }
  const allowedCodes = new Set(['network_error', 'runtime_exception', 'console_error']);
  const pageErrorCodes = Array.isArray(diagnostics?.pageErrorCodes)
    ? [...new Set(diagnostics.pageErrorCodes.filter((code) => allowedCodes.has(code)))].slice(0, 3) : [];
  return { httpStatusCounts, pageErrorCodes };
}
/** Preserves a completed first-population receipt; failures add diagnostics only before completion. */
export function firstPopulationAfterFailure(receipt, error) {
  if (receipt.status === 'completed') return receipt;
  const diagnostics = browserFailureDiagnostics(error);
  return {
    ...receipt,
    httpStatusCounts: diagnostics.httpStatusCounts,
    pageErrorCodes: diagnostics.pageErrorCodes,
    pageErrorCounts: aggregatePageErrorCounts([diagnostics]),
  };
}

/** Classifies deadline and timeout failures separately from ordinary UI errors. */
export function classifyObservationFailure(error, datasetDeadlineExpired = false) {
  const code = typeof error?.code === 'string' ? error.code : '';
  const message = typeof error?.message === 'string' ? error.message : '';
  const censored = datasetDeadlineExpired === true || code.includes('deadline') || code.includes('timeout')
    || message.includes('deadline') || message.includes('timeout');
  return { status: censored ? 'timeout' : 'error', censored };
}
function safeFailureCode(error, cancellationCode) {
  if (cancellationCode === 'dataset_deadline_exceeded') return cancellationCode;
  if (cancellationCode) return 'signal_interrupted';
  const candidate = typeof error?.code === 'string' ? error.code : typeof error?.message === 'string' ? error.message : '';
  if (candidate === 'cleanup_unproven') return 'review_page_failed';
  if (FAILURE_CODES.has(candidate)) return candidate;
  if (candidate.includes('deadline') || candidate.includes('timeout')) return 'deadline_exceeded';
  if (candidate.includes('source_grant')) return 'source_grant_unavailable';
  if (candidate.includes('source_admission')) return 'source_admission_unproven';
  if (candidate.includes('identity')) return 'identity_unverified';
  if (candidate.includes('actual_import') || candidate.includes('actual_balance')) return 'actual_import_unproven';
  if (candidate.includes('review_sync') || candidate.includes('sync_http')) return 'review_sync_failed';
  if (candidate.includes('review_page')) return 'review_page_failed';
  if (candidate.includes('source') || candidate.includes('queue')) return 'source_queue_invariant_failed';
  if (candidate.includes('screenshot')) return 'review_screenshot_unavailable';
  if (candidate.includes('ui_')) return 'review_ui_unproven';
  return 'runtime_error';
}

function aggregateCounts(items) {
  return items.reduce((accumulator, item) => mergeStatusCounts(accumulator, item?.httpStatusCounts), {});
}
function aggregatePageErrorCounts(items) {
  const counts = { network_error: 0, runtime_exception: 0, console_error: 0 };
  for (const item of items)
    for (const code of item?.pageErrorCodes ?? [])
      if (Object.hasOwn(counts, code)) counts[code] = Math.min(100, counts[code] + 1);
  return counts;
}

function failureDataset(size, code, preparationElapsedMs = null) {
  return {
    size, status: 'failed', cleanupStatus: 'completed', failureCode: code, identityFingerprint: null, preparationElapsedMs,
    batchSize: ACTUAL_BATCH_SIZE, batchCount: 0, generatedHistoryCount: 0, grantsProvisioned: 0,
    actualReadbackMs: null, independentCaptureMs: null, originGuardStatus: null, originGuardQueueUnchanged: null,
    source: { count: null, originalCount: null, retainedCount: null, truncatedCount: null,
      rawActualRowCount: null, startingBalanceCount: null, splitParentCount: null, splitChildCount: null,
      excludedRawRowCount: null, baselineCount: null, appendHeadroom: null, generatedHistoryCount: 0,
      eligibleCount: null, candidateCount: null, persistedCount: null, visibleCount: null,
      asOfDate: null, captureStartDate: null, captureEndDate: null, analysisStartDate: null, analysisEndDate: null,
      actualReadbackIdsSha256: null, exactReadback: false, independentPublishedCapture: false, collectionsComplete: false },
    queue: { count: null, persistedCount: null, visibleCount: null, maximumUiCount: UI_QUEUE_MAX, idsSha256: null, stable: false },
    money: { currency: 'USD', generatedMinorUnits: null, accountBalanceBeforeMinorUnits: null,
      accountBalanceAfterMinorUnits: null, balanceCheck: false },
    firstPopulation: { status: 'unproven', elapsedMs: null, sourceCount: null, candidateCount: null,
      persistedCount: null, visibleCount: null, queueCount: null, httpStatusCounts: {}, pageErrorCodes: [],
      pageErrorCounts: { network_error: 0, runtime_exception: 0, console_error: 0 },
      queueFingerprint: null, currentItemFingerprint: null },
    warmups: [], samples: [], completedWarmups: 0, attemptedSamples: 0, completedSamples: 0,
    failedSamples: 0, censoredSamples: 0, p95ElapsedMs: null, referenceStatus: 'unproven', uiThresholdMs: null,
    memory: { state: 'unproven', approximate: true, scope: MEMORY_SCOPE, sampleCount: 0, failedReads: 0,
      actual: null, web: null, reason: 'owned_process_memory_unavailable' }, uiProof: null,
  };
}
export function finalizeDatasetOutcome(dataset, cleanupUnproven, { signal, deadlineAt, deadlineExpired } = {}) {
  dataset.cleanupStatus = cleanupUnproven ? 'unproven' : 'completed';
  if (cleanupUnproven) {
    dataset.status = 'failed';
    dataset.failureCode = 'cleanup_unproven';
    dataset.p95ElapsedMs = null;
    dataset.referenceStatus = 'unproven';
  } else {
    const failureCode = deadlineExpired?.() || performance.now() > deadlineAt ? 'dataset_deadline_exceeded'
      : signal?.aborted ? 'signal_interrupted' : null;
    if (failureCode) {
      dataset.status = 'failed';
      dataset.failureCode = failureCode;
      dataset.p95ElapsedMs = null;
      dataset.referenceStatus = 'unproven';
    }
  }
  if (dataset.firstPopulation?.status === 'completed' && dataset.failureCode && dataset.queue)
    dataset.queue.stable = false;
  return dataset;
}


async function runDatasetBody(options, size, signal, deadlineExpired, datasetDeadlineAt) {
  const datasetStarted = performance.now();
  const dataset = failureDataset(size, 'scenario_setup_failed');
  let root;
  let processes;
  let loaded;
  let store;
  let writerOpen = false;
  let browser;
  let page;
  let expectedSourceIds = [];
  let expectedCurrentItemFingerprint = null;
  let expectedCurrentItem = null;
  let expectedQueueIds = [];
  let generatedRows = [];
  let generatedMinorUnits = 0n;
  let baselineRawRows = [];
  let sourceMetrics = null;
  let appHttp = null;
  let owner = null;
  let sourceAdmissionResult = null;
  const warmupObservations = [];
  const sampleObservations = [];
  let actualReadbackMs = null;
  let independentCaptureMs = null;
  let grantsProvisioned = 0;
  let batchCount = 0;
  let accountId = null;
  let accountBalanceBefore = null;
  let accountBalanceAfter = null;
  let grantStoreOpen = false;
  let cleanupUnproven = false;
  let memoryBaseline = null;
  let memoryWindowStarted = false;
  let memoryWindowFinished = false;
  let memoryTimer = null;
  let memoryReadPromise = null;
  let memoryFailedReads = 0;
  const memorySamples = [];
  let preparationFinished = false;
  const endPreparation = () => {
    if (preparationFinished) return;
    preparationFinished = true;
  };
  const cancellationCode = () => deadlineExpired() ? 'dataset_deadline_exceeded'
    : signal?.aborted ? 'signal_interrupted' : null;
  const checkDeadline = () => {
    const cancelled = cancellationCode();
    if (cancelled) fail(cancelled);
    if (performance.now() > datasetDeadlineAt) fail('dataset_deadline_exceeded');
  };
  const captureMemoryReading = () => {
    if (!processes) return null;
    try {
      const snapshot = readScenarioProcessMemory(processes);
      if (plainObject(snapshot)) return snapshot;
    } catch { /* Memory evidence is best-effort and never replaces benchmark success. */ }
    memoryFailedReads += 1;
    return null;
  };
  const startMemoryWindow = () => {
    if (memoryWindowStarted) return;
    endPreparation();
    memoryWindowStarted = true;
    memoryBaseline = captureMemoryReading();
    memoryTimer = setInterval(() => {
      if (memoryReadPromise) return;
      memoryReadPromise = Promise.resolve().then(captureMemoryReading).then((snapshot) => {
        if (snapshot) memorySamples.push(snapshot);
      }).finally(() => { memoryReadPromise = null; });
    }, 250);
    memoryTimer.unref?.();
  };
  const finishMemoryWindow = async () => {
    if (memoryWindowFinished) return;
    clearInterval(memoryTimer);
    memoryTimer = null;
    if (memoryWindowStarted && memoryReadPromise) await memoryReadPromise;
    const ending = memoryWindowStarted ? captureMemoryReading() : null;
    dataset.memory = summarizeProcessMemory({
      baseline: memoryBaseline, ending, samples: memorySamples, failedReads: memoryFailedReads,
    });
    memoryWindowFinished = true;
  };
  try {
    checkDeadline();
    const scenario = materializeScenario(SCENARIO_ID, SCENARIO_ANCHOR);
    root = createOwnedScenarioRoot();
    processes = await startScenarioShell({ root, webEntry: builtWebEntry(), scenarioId: SCENARIO_ID });
    checkDeadline();
    loaded = await initializeScenarioShell(processes, scenario, signal);
    checkDeadline();
    store = new SqliteWorkflowStore(processes.workflowDbPath);
    grantStoreOpen = true;

    const ownerSeed = loaded.initialized.personas.owner;
    if (!ownerSeed) throw new Error('identity_unverified');
    appHttp = new ScenarioHttpClient(processes.webUrl, processes.publicOrigin, processes.internalSecret, signal);
    const signedInActor = await appHttp.signIn(ownerSeed.email, ownerSeed.password);
    checkDeadline();
    await appHttp.selectSpace(loaded.initialized.spaceId);
    checkDeadline();
    const session = await appHttp.currentSession();
    checkDeadline();
    if (signedInActor !== ownerSeed.actorId || session.actorId !== ownerSeed.actorId) throw new Error('identity_unverified');
    const verified = verifyIdentity(store, loaded, session);
    owner = verified.owner;
    dataset.identityFingerprint = verified.identityFingerprint;

    const baseEnvelope = requireEnvelope(await appHttp.get('/api/merchant'));
    checkDeadline();
    const baseAdmission = sourceAdmission(baseEnvelope);
    if (!baseAdmission.collectionsComplete || baseAdmission.truncatedCount !== 0) throw new Error('source_admission_unproven');
    if (baseAdmission.sourceCount >= size) throw new Error('source_below_requested_size');
    dataset.source.baselineCount = baseAdmission.sourceCount;
    dataset.source.appendHeadroom = size - baseAdmission.sourceCount;

    const accountTemplate = scenario.ledger.transactions.find((row) => row.categoryId !== null && row.payeeId !== null);
    if (!accountTemplate) throw new Error('canonical_template_unavailable');
    const logicalAccount = scenario.ledger.accounts.find((account) => account.id === accountTemplate.accountId);
    if (!logicalAccount || logicalAccount.clearedBalance?.currency !== 'USD' ||
      logicalAccount.importedBalance?.currency !== 'USD' ||
      scenario.ledger.accounts.some((account) => account.clearedBalance?.currency !== 'USD' ||
        account.importedBalance?.currency !== 'USD'))
      throw new Error('canonical_usd_fixture_required');
    accountId = loaded.seeded.accountIds[accountTemplate.accountId];
    const categoryId = loaded.seeded.categoryIds[accountTemplate.categoryId];
    const payeeId = loaded.seeded.payeeIds[accountTemplate.payeeId];
    if (!accountId || !categoryId || !payeeId) throw new Error('actual_fixture_mapping_unavailable');

    const targetLogicalIds = scenario.merchant?.targetTransactionIds;
    if (!Array.isArray(targetLogicalIds) || targetLogicalIds.length === 0 || targetLogicalIds.length > UI_QUEUE_MAX)
      throw new Error('canonical_target_unavailable');
    for (const logicalId of targetLogicalIds) {
      const nativeId = loaded.seeded.transactionIds[logicalId];
      if (!nativeId || expectedQueueIds.includes(nativeId)) throw new Error('actual_fixture_mapping_unavailable');
      expectedQueueIds.push(nativeId);
    }
    const target = scenario.ledger.transactions.find(({ id }) => id === targetLogicalIds[0]);
    const targetAccountId = target && loaded.seeded.accountIds[target.accountId];
    const targetAmount = Number(target?.amount?.minorUnits);
    if (!target || !targetAccountId || !Number.isSafeInteger(targetAmount) ||
      target.amount?.currency !== 'USD' || typeof target.importedPayee !== 'string' || !target.importedPayee)
      throw new Error('canonical_target_unavailable');
    expectedCurrentItem = {
      transactionId: expectedQueueIds[0], accountId: targetAccountId, amount: targetAmount,
      currency: target.amount.currency, originalImportedName: target.importedPayee,
      nativeImportedName: target.importedPayee,
    };

    const writerDir = createPrivateDirectory(root, 'actual-writer');
    const writerClient = await openActual(writerDir, processes, loaded.seeded.groupId);
    writerOpen = true;
    const accounts = await actualApi.getAccounts();
    checkDeadline();
    if (!Array.isArray(accounts)) throw new Error('actual_usd_account_unavailable');
    const actualAccountIds = new Set(accounts.map((account) => account?.id).filter((id) => typeof id === 'string'));
    if (Object.values(loaded.seeded.accountIds).some((id) => !actualAccountIds.has(id)))
      throw new Error('actual_usd_account_unavailable');
    baselineRawRows = await actualRows(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    const baselineBalances = await actualBalances(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    accountBalanceBefore = baselineBalances.get(accountId);
    if (!Number.isSafeInteger(accountBalanceBefore)) throw new Error('actual_balance_unavailable');
    const queueBefore = await readPersistedQueue(store, loaded.seeded.budgetId);
    checkDeadline();
    if (queueBefore.count > UI_QUEUE_MAX) throw new Error('source_queue_invariant_failed');

    const appendCount = size - baseAdmission.sourceCount;
    generatedRows = buildTransactions(scenario.ledger, appendCount, {
      accountId, payeeId, categoryId, initialBalanceMinorUnits: accountBalanceBefore, importPrefix: size,
      analysisStartDate: baseAdmission.analysisStartDate, analysisEndDate: baseAdmission.analysisEndDate,
    });
    generatedMinorUnits = generatedRows.reduce((sum, row) => sum + BigInt(row.amount), 0n);
    const projected = BigInt(accountBalanceBefore) + generatedMinorUnits;
    if (projected < -BigInt(Number.MAX_SAFE_INTEGER) || projected > BigInt(Number.MAX_SAFE_INTEGER))
      throw new Error('projected_balance_unsafe');

    const expectedFinancialSnapshot = {
      baselineRows: baselineRawRows, baselineBalances,
      appendAccountId: accountId, generatedMinorUnits,
    };
    for (let offset = 0; offset < generatedRows.length; offset += ACTUAL_BATCH_SIZE) {
      checkDeadline();
      const batch = generatedRows.slice(offset, offset + ACTUAL_BATCH_SIZE);
      await actualApi.addTransactions(accountId, batch, { runTransfers: false, learnCategories: false });
      checkDeadline();
      await actualApi.sync();
      checkDeadline();
      batchCount += 1;
    }
    const readbackStarted = performance.now();
    const afterImportRows = await actualRows(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    const generatedActualIds = verifyGeneratedReadback(afterImportRows, generatedRows, accountId);
    if (generatedActualIds.length !== appendCount) throw new Error('actual_import_readback_incomplete');
    const afterBalances = await actualBalances(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    accountBalanceAfter = afterBalances.get(accountId);
    const expectedRawIds = [...baselineRawRows.map((row) => row.id), ...generatedActualIds];
    const sourceSetCheck = assertSourceQueueSnapshot({
      sourceIds: expectedRawIds, queueIds: queueBefore.ids, financial: expectedFinancialSnapshot,
    }, {
      sourceIds: afterImportRows.map((row) => row.id), queueIds: queueBefore.ids,
      financial: { rows: afterImportRows, balances: afterBalances },
    });
    if (sourceSetCheck.sourceCount !== baselineRawRows.length + appendCount) throw new Error('actual_source_readback_mismatch');
    expectedSourceIds = expectedRawIds;
    actualReadbackMs = performance.now() - readbackStarted;
    const publishedGroupId = await publishActualSnapshot(writerClient, loaded.seeded.budgetId);
    checkDeadline();
    await closeActual();
    writerOpen = false;
    checkDeadline();

    const independentDir = createPrivateDirectory(root, 'actual-independent-readback');
    const captureStarted = performance.now();
    await openActual(independentDir, processes, publishedGroupId);
    writerOpen = true;
    const independentlyReadRows = await actualRows(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    const independentIds = verifyGeneratedReadback(independentlyReadRows, generatedRows, accountId);
    if (independentIds.length !== generatedActualIds.length ||
      fingerprintIds(independentIds) !== fingerprintIds(generatedActualIds)) throw new Error('independent_actual_capture_mismatch');
    const independentBalances = await actualBalances(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    assertSourceQueueSnapshot({
      sourceIds: expectedRawIds, queueIds: queueBefore.ids, financial: expectedFinancialSnapshot,
    }, {
      sourceIds: independentlyReadRows.map((row) => row.id), queueIds: queueBefore.ids,
      financial: { rows: independentlyReadRows, balances: independentBalances },
    });
    independentCaptureMs = performance.now() - captureStarted;
    await closeActual();
    writerOpen = false;
    checkDeadline();
    await appHttp.reauthenticate(ownerSeed.password);
    checkDeadline();
    const reconnected = requireEnvelope(await appHttp.post('/api/connection', { budgetId: loaded.seeded.budgetId }));
    checkDeadline();
    if (reconnected.budget?.id !== loaded.seeded.budgetId || reconnected.budget?.groupId !== publishedGroupId)
      throw new Error('actual_budget_snapshot_identity_mismatch');
    const writerReopenDir = createPrivateDirectory(root, 'actual-source-monitor');
    await openActual(writerReopenDir, processes, publishedGroupId);
    writerOpen = true;
    checkDeadline();
    grantsProvisioned = provisionExactSourceGrants(store, loaded, owner, generatedActualIds, checkDeadline);
    // Budget summary refreshes the selected web SDK in Observe mode without creating Review items.
    requireEnvelope(await appHttp.get('/api/home/budget-summary'));
    checkDeadline();

    const finalEnvelope = requireEnvelope(await appHttp.get('/api/merchant'));
    checkDeadline();
    sourceAdmissionResult = sourceAdmission(finalEnvelope);
    if (finalEnvelope.scope?.spaceId !== loaded.initialized.spaceId || finalEnvelope.scope?.budgetId !== loaded.seeded.budgetId ||
      sourceAdmissionResult.sourceCount !== size || sourceAdmissionResult.originalSourceCount !== size ||
      sourceAdmissionResult.retainedCount !== size || sourceAdmissionResult.truncatedCount !== 0 ||
      !sourceAdmissionResult.collectionsComplete || sourceAdmissionResult.asOfDate !== baseAdmission.asOfDate ||
      sourceAdmissionResult.captureStartDate !== baseAdmission.captureStartDate ||
      sourceAdmissionResult.captureEndDate !== baseAdmission.captureEndDate ||
      sourceAdmissionResult.analysisStartDate !== baseAdmission.analysisStartDate ||
      sourceAdmissionResult.analysisEndDate !== baseAdmission.analysisEndDate)
      throw new Error('source_admission_unproven');
    if (sourceAdmissionResult.eligibleCount > size) throw new Error('source_admission_invalid');
    const postGrantRows = await actualRows(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    assertSourceQueueSnapshot({ sourceIds: expectedSourceIds, queueIds: queueBefore.ids },
      { sourceIds: postGrantRows.map((row) => row.id), queueIds: queueBefore.ids });
    sourceMetrics = rawActualCounts(postGrantRows);
    const excludedRawRowCount = sourceMetrics.rawActualRowCount - sourceAdmissionResult.sourceCount;
    if (!Number.isSafeInteger(excludedRawRowCount) || excludedRawRowCount < 0) throw new Error('source_admission_unproven');
    dataset.source = {
      count: sourceAdmissionResult.sourceCount, originalCount: sourceAdmissionResult.originalSourceCount,
      retainedCount: sourceAdmissionResult.retainedCount, truncatedCount: sourceAdmissionResult.truncatedCount,
      rawActualRowCount: sourceMetrics.rawActualRowCount, startingBalanceCount: sourceMetrics.startingBalanceCount,
      splitParentCount: sourceMetrics.splitParentCount, splitChildCount: sourceMetrics.splitChildCount,
      excludedRawRowCount, baselineCount: baseAdmission.sourceCount, appendHeadroom: appendCount,
      asOfDate: sourceAdmissionResult.asOfDate, captureStartDate: sourceAdmissionResult.captureStartDate,
      captureEndDate: sourceAdmissionResult.captureEndDate, analysisStartDate: sourceAdmissionResult.analysisStartDate,
      analysisEndDate: sourceAdmissionResult.analysisEndDate,
      generatedHistoryCount: generatedRows.length, eligibleCount: sourceAdmissionResult.eligibleCount,
      candidateCount: null, persistedCount: 0, visibleCount: 0,
      actualReadbackIdsSha256: fingerprintIds(expectedSourceIds), exactReadback: true,
      independentPublishedCapture: true, collectionsComplete: true,
    };
    dataset.status = 'unproven';
    dataset.failureCode = null;
    dataset.preparationElapsedMs = performance.now() - datasetStarted;
    dataset.batchSize = ACTUAL_BATCH_SIZE;
    dataset.batchCount = batchCount;
    dataset.generatedHistoryCount = generatedRows.length;
    dataset.grantsProvisioned = grantsProvisioned;
    dataset.actualReadbackMs = actualReadbackMs;
    dataset.independentCaptureMs = independentCaptureMs;
    dataset.money = { currency: 'USD', generatedMinorUnits: generatedMinorUnits.toString(),
      accountBalanceBeforeMinorUnits: accountBalanceBefore, accountBalanceAfterMinorUnits: accountBalanceAfter, balanceCheck: true };
    await appHttp.reauthenticate(owner.password);
    checkDeadline();
    const guardSession = await appHttp.currentSession();
    checkDeadline();
    if (guardSession.actorId !== owner.actorId) throw new Error('identity_unverified');
    const originQueueBefore = await readPersistedQueue(store, loaded.seeded.budgetId);
    checkDeadline();
    if (originQueueBefore.count > UI_QUEUE_MAX) throw new Error('source_queue_invariant_failed');
    let originRequestCompleted = false;
    let originGuardStatus = null;
    try {
      const response = await fetch(new URL('/api/review/sync', processes.webUrl), {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          origin: 'http://foreign-origin.invalid',
          cookie: appHttp.cookieHeader,
          'x-balanceframe-space': loaded.initialized.spaceId,
        },
        body: '{}',
        signal: AbortSignal.any([signal, AbortSignal.timeout(options.deadlineMs)]),
      });
      originGuardStatus = response.status;
      dataset.originGuardStatus = response.status;
      originRequestCompleted = true;
      await response.body?.cancel();
    } catch { /* Keep a received HTTP status when only body disposal fails. */ }
    checkDeadline();
    const originRowsAfter = await actualRows(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    const originQueueAfter = await readPersistedQueue(store, loaded.seeded.budgetId);
    let originQueueUnchanged = false;
    try {
      assertSourceQueueSnapshot(
        { sourceIds: expectedSourceIds, queueIds: originQueueBefore.ids },
        { sourceIds: originRowsAfter.map((row) => row.id), queueIds: originQueueAfter.ids },
      );
      originQueueUnchanged = true;
    } catch { /* The queue snapshot remains unproven. */ }
    dataset.originGuardQueueUnchanged = originRequestCompleted ? originQueueUnchanged : null;
    if (!originRequestCompleted || originGuardStatus !== 403 || !originQueueUnchanged)
      throw new Error('origin_guard_unproven');
    browser = await startOwnedChromium({ chromiumPath: options.chromiumPath,
      profilePath: path.join(root, 'chromium-profile'), timeoutMs: options.deadlineMs, signal });
    checkDeadline();
    const refreshSession = async () => {
      checkDeadline();
      await appHttp.reauthenticate(owner.password);
      checkDeadline();
      const refreshed = await appHttp.currentSession();
      checkDeadline();
      if (refreshed.actorId !== owner.actorId) throw new Error('identity_unverified');
      return appHttp.cookieHeader;
    };
    const initialCookieHeader = await refreshSession();
    page = await createReviewPage(browser, new URL('/review', processes.webUrl).toString(),
      initialCookieHeader, options.deadlineMs, signal);
    checkDeadline();
    const initialQueue = await readPersistedQueue(store, loaded.seeded.budgetId);
    checkDeadline();
    if (!Array.isArray(page.initialQueueIds) || page.initialQueueIds.length !== 0 || initialQueue.count !== 0)
      throw new Error('source_queue_invariant_failed');
    const initialRows = await actualRows(Object.values(loaded.seeded.accountIds));
    checkDeadline();
    assertSourceQueueSnapshot({ sourceIds: expectedSourceIds, queueIds: page.initialQueueIds },
      { sourceIds: initialRows.map((row) => row.id), queueIds: initialQueue.ids });
    const verifyCurrentAdmission = async () => {
      checkDeadline();
      const session = await appHttp.currentSession();
      checkDeadline();
      if (session.actorId !== owner.actorId) throw new Error('identity_unverified');
      const currentEnvelope = requireEnvelope(await appHttp.get('/api/merchant'));
      checkDeadline();
      const current = sourceAdmission(currentEnvelope);
      if (currentEnvelope.scope?.spaceId !== loaded.initialized.spaceId ||
        currentEnvelope.scope?.budgetId !== loaded.seeded.budgetId ||
        current.sourceCount !== sourceAdmissionResult.sourceCount ||
        current.originalSourceCount !== sourceAdmissionResult.originalSourceCount ||
        current.retainedCount !== sourceAdmissionResult.retainedCount || current.truncatedCount !== 0 ||
        current.eligibleCount !== sourceAdmissionResult.eligibleCount || !current.collectionsComplete ||
        current.asOfDate !== sourceAdmissionResult.asOfDate ||
        current.captureStartDate !== sourceAdmissionResult.captureStartDate ||
        current.captureEndDate !== sourceAdmissionResult.captureEndDate ||
        current.analysisStartDate !== sourceAdmissionResult.analysisStartDate ||
        current.analysisEndDate !== sourceAdmissionResult.analysisEndDate)
        throw new Error('source_admission_unproven');
    };
    const syncAndAssert = async (queueIds, adoptInitialQueue = false) => {
      const cookieHeader = await refreshSession();
      const beforeRows = await actualRows(Object.values(loaded.seeded.accountIds));
      checkDeadline();
      const persistedBefore = await readPersistedQueue(store, loaded.seeded.budgetId);
      checkDeadline();
      if (persistedBefore.count > UI_QUEUE_MAX) throw new Error('source_queue_invariant_failed');
      assertSourceQueueSnapshot({ sourceIds: expectedSourceIds, queueIds: adoptInitialQueue ? [] : queueIds },
        { sourceIds: beforeRows.map((row) => row.id), queueIds: persistedBefore.ids });
      await verifyCurrentAdmission();
      const uiResult = await performSync(page, { cookieHeader,
        expectedQueueIds: adoptInitialQueue ? null : queueIds, deadlineMs: options.deadlineMs,
        onArmed: startMemoryWindow });
      checkDeadline();
      try {
        checkDeadline();
        await verifyCurrentAdmission();
        if (!Number.isSafeInteger(uiResult.visibleCount) || uiResult.visibleCount !== uiResult.queueCount ||
          !uiResult.syncEnabled || uiResult.pageErrorCodes.length > 0) throw new Error('review_ui_unproven');
        const currentItemFingerprint = hashCurrentItem(uiResult.currentItem, expectedCurrentItem);
        if (expectedCurrentItemFingerprint && currentItemFingerprint !== expectedCurrentItemFingerprint)
          throw new Error('fixture_current_item_mismatch');
        const persisted = await readPersistedQueue(store, loaded.seeded.budgetId);
        checkDeadline();
        const sourceAfterRows = await actualRows(Object.values(loaded.seeded.accountIds));
        checkDeadline();
        if (persisted.count > UI_QUEUE_MAX || persisted.count !== uiResult.queueCount)
          throw new Error('source_queue_invariant_failed');
        const currentItemRow = sourceAfterRows.find((row) => row.id === uiResult.currentItem.transactionId);
        const expectedPostQueueIds = adoptInitialQueue ? expectedQueueIds : queueIds;
        assertSourceQueueSnapshot({
          sourceIds: expectedSourceIds, queueIds: expectedPostQueueIds,
          canonicalQueueIds: expectedQueueIds, currentItem: expectedCurrentItem,
        }, {
          sourceIds: sourceAfterRows.map((row) => row.id), queueIds: persisted.ids,
          currentItem: {
            transactionId: uiResult.currentItem.transactionId,
            accountId: currentItemRow?.accountId, amount: currentItemRow?.amount,
            currency: uiResult.currentItem.currency, originalImportedName: uiResult.currentItem.originalImportedName,
            nativeImportedName: currentItemRow?.imported_payee,
          },
        });
        assertSourceQueueSnapshot({ sourceIds: expectedSourceIds, queueIds: persisted.ids },
          { sourceIds: sourceAfterRows.map((row) => row.id), queueIds: uiResult.queueIds });
        const persistedAddedCount = persisted.ids.filter((id) => !persistedBefore.ids.includes(id)).length;
        const persistedRemovedCount = persistedBefore.ids.filter((id) => !persisted.ids.includes(id)).length;
        return { ...uiResult, persisted, sourceIds: sourceAfterRows.map((row) => row.id),
          persistedAddedCount, persistedRemovedCount, currentItemFingerprint };
      } catch (error) {
        if (error && typeof error === 'object')
          error.browserDiagnostics ??= { httpStatusCounts: uiResult.httpStatusCounts, pageErrorCodes: uiResult.pageErrorCodes };
        throw error;
      }
    };

    const first = await syncAndAssert(expectedQueueIds, true);
    expectedCurrentItemFingerprint = first.currentItemFingerprint;
    if (expectedQueueIds.length === 0 || expectedQueueIds.length > UI_QUEUE_MAX ||
      expectedQueueIds.length !== first.visibleCount) throw new Error('source_queue_invariant_failed');
    if (first.candidateCount === null) throw new Error('review_sync_failed');
    dataset.source.candidateCount = first.candidateCount;
    dataset.source.persistedCount = first.persisted.count;
    dataset.source.visibleCount = first.visibleCount;
    dataset.queue = { count: first.persisted.count, persistedCount: first.persisted.count,
      visibleCount: first.visibleCount, maximumUiCount: UI_QUEUE_MAX, idsSha256: fingerprintIds(expectedQueueIds), stable: true };
    const firstQueueFingerprint = fingerprintIds(expectedQueueIds);
    const firstCurrentItemFingerprint = first.currentItemFingerprint;
    dataset.firstPopulation = {
      status: 'completed', elapsedMs: first.elapsedMs, sourceCount: sourceAdmissionResult.sourceCount,
      candidateCount: first.candidateCount, persistedCount: first.persisted.count,
      visibleCount: first.visibleCount, queueCount: first.queueCount,
      persistedAddedCount: first.persistedAddedCount, persistedRemovedCount: first.persistedRemovedCount,
      httpStatusCounts: first.httpStatusCounts, pageErrorCodes: first.pageErrorCodes,
      pageErrorCounts: aggregatePageErrorCounts([first]),
      queueFingerprint: firstQueueFingerprint, currentItemFingerprint: firstCurrentItemFingerprint,
    };

    for (let index = 0; index < options.warmups; index += 1) {
      try {
        const result = await syncAndAssert(expectedQueueIds);
        warmupObservations.push(makeObservation(result, sourceAdmissionResult, result.persisted.count));
      } catch (error) {
        const failure = classifyObservationFailure(error, deadlineExpired());
        warmupObservations.push(makeObservation({ ...browserFailureDiagnostics(error), ...failure },
          sourceAdmissionResult, expectedQueueIds.length, false));
        dataset.failureCode = safeFailureCode(error, cancellationCode());
        break;
      }
    }
    if (!dataset.failureCode) {
      for (let index = 0; index < options.iterations; index += 1) {
        try {
          const result = await syncAndAssert(expectedQueueIds);
          sampleObservations.push(makeObservation(result, sourceAdmissionResult, result.persisted.count));
        } catch (error) {
          const failure = classifyObservationFailure(error, deadlineExpired());
          sampleObservations.push(makeObservation({ ...browserFailureDiagnostics(error), ...failure },
            sourceAdmissionResult, expectedQueueIds.length, false));
          dataset.failureCode = safeFailureCode(error, cancellationCode());
          break;
        }
      }
    }
    await finishMemoryWindow();
    const summary = aggregate({ size, warmups: warmupObservations, samples: sampleObservations });
    dataset.warmups = warmupObservations;
    dataset.samples = sampleObservations;
    dataset.completedWarmups = summary.completedWarmups;
    dataset.attemptedSamples = summary.attemptedSamples;
    dataset.completedSamples = summary.completedSamples;
    dataset.failedSamples = summary.failedSamples;
    dataset.censoredSamples = summary.censoredSamples;
    dataset.p95ElapsedMs = summary.p95ElapsedMs;
    dataset.referenceStatus = summary.referenceStatus;
    dataset.uiThresholdMs = null;
    dataset.status = summary.referenceStatus === 'descriptive' ? 'completed' : 'unproven';

    if (dataset.firstPopulation.status === 'completed') {
      const screenshot = await captureReviewScreenshot(page, first.currentItem.originalImportedName);
      const outputBase = path.basename(options.output, path.extname(options.output));
      const screenshotFileName = `${outputBase}-${size}.ui.png`;
      const screenshotPath = path.join(path.dirname(options.output), screenshotFileName);
      writePrivateBytes(screenshotPath, screenshot);
      const allUiResults = [first, ...warmupObservations, ...sampleObservations];
      const httpStatusCounts = aggregateCounts(allUiResults);
      const pageErrorCodes = allUiResults.flatMap((result) => result.pageErrorCodes ?? []);
      const pageErrorCounts = aggregatePageErrorCounts(allUiResults);
      dataset.uiProof = { screenshotFileName, screenshotSha256: `sha256:${sha256(screenshot)}`,
        queueFingerprint: fingerprintIds(expectedQueueIds), currentItemFingerprint: firstCurrentItemFingerprint,
        httpStatusCounts, pageErrorCodes, pageErrorCounts };
    }
    return dataset;
  } catch (error) {
    dataset.status = 'failed';
    if (error?.ownedCleanupUnproven === true) {
      cleanupUnproven = true;
      dataset.failureCode = 'cleanup_unproven';
    } else dataset.failureCode = safeFailureCode(error, cancellationCode());
    if (dataset.preparationElapsedMs === null)
      dataset.preparationElapsedMs = performance.now() - datasetStarted;
    dataset.warmups = warmupObservations;
    dataset.samples = sampleObservations;
    const summary = aggregate({ size, warmups: warmupObservations, samples: sampleObservations });
    dataset.completedWarmups = summary.completedWarmups;
    dataset.attemptedSamples = summary.attemptedSamples;
    dataset.completedSamples = summary.completedSamples;
    dataset.failedSamples = summary.failedSamples;
    dataset.censoredSamples = summary.censoredSamples;
    dataset.p95ElapsedMs = null;
    dataset.referenceStatus = 'unproven';
    dataset.uiThresholdMs = null;
    if (sourceAdmissionResult) {
      dataset.source.count = sourceAdmissionResult.sourceCount;
      dataset.source.originalCount = sourceAdmissionResult.originalSourceCount;
      dataset.source.retainedCount = sourceAdmissionResult.retainedCount;
      dataset.source.truncatedCount = sourceAdmissionResult.truncatedCount;
      dataset.source.eligibleCount = sourceAdmissionResult.eligibleCount;
      dataset.source.collectionsComplete = sourceAdmissionResult.collectionsComplete;
      dataset.source.asOfDate = sourceAdmissionResult.asOfDate;
      dataset.source.captureStartDate = sourceAdmissionResult.captureStartDate;
      dataset.source.captureEndDate = sourceAdmissionResult.captureEndDate;
      dataset.source.analysisStartDate = sourceAdmissionResult.analysisStartDate;
      dataset.source.analysisEndDate = sourceAdmissionResult.analysisEndDate;
    }
    dataset.firstPopulation = firstPopulationAfterFailure(dataset.firstPopulation, error);
    return dataset;
  } finally {
    endPreparation();
    const attemptCleanup = async (action) => {
      try { await action(); } catch { cleanupUnproven = true; }
    };
    await attemptCleanup(finishMemoryWindow);
    if (page) await attemptCleanup(() => closeReviewPage(page));
    if (browser) await attemptCleanup(() => closeOwnedChromium(browser));
    if (writerOpen) await attemptCleanup(closeActual);
    if (grantStoreOpen) await attemptCleanup(() => store.close());
    if (processes) await attemptCleanup(() => stopScenarioProcesses(processes, { retainRoot: cleanupUnproven }));
    else if (root && !cleanupUnproven) await attemptCleanup(() => discardOwnedScenarioRoot(root));
    finalizeDatasetOutcome(dataset, cleanupUnproven, { signal, deadlineAt: datasetDeadlineAt, deadlineExpired });
  }
}
async function runDataset(options, size, externalSignal) {
  return withDatasetDeadline(options.datasetDeadlineMs, externalSignal,
    ({ signal, deadlineAt, deadlineExpired }) =>
      withActualFetchSignal(signal, () =>
        runDatasetBody(options, size, signal, deadlineExpired, deadlineAt)));
}

function reportStatus(datasets) {
  if (!datasets.length) return 'failed';
  if (datasets.every((dataset) => dataset.status === 'completed')) return 'completed';
  return datasets.some((dataset) => dataset.status === 'completed') ? 'partial' : 'unproven';
}

async function main(options) {
  if (options.help) {
    process.stdout.write('Usage: taskset -c 0,1 node scripts/merchant-intelligence/review.mjs [--sizes 50000,250000] [--warmups 2] [--iterations 20] [--deadline-ms 30000] [--dataset-deadline-ms 3600000] --chromium-path /opt/google/chrome/chrome --output NEW-private-report.json\nFull authenticated Actual-backed Review UI; generated rows are categorized USD performance history, not quality labels.\n');
    return;
  }
  assertNewArtifactPath(options.output);
  for (const size of options.sizes) {
    const screenshotName = `${path.basename(options.output, path.extname(options.output))}-${size}.ui.png`;
    assertNewArtifactPath(path.join(path.dirname(options.output), screenshotName));
  }
  const chromiumStats = lstatSync(options.chromiumPath);
  if (!chromiumStats.isFile() || chromiumStats.isSymbolicLink()) throw new Error('chromium_executable_invalid');
  const affinity = getCpuAffinity();
  const scenarioFixture = path.join(ROOT, 'protocol/fixtures/scenarios/merchant.json');
  const nativeAddon = path.join(ROOT, 'crates/node-binding/balanceframe.node');
  const webEntry = path.join(ROOT, 'apps/web/.output/server/index.mjs');
  const benchmarkSpec = path.join(path.dirname(SCRIPT), 'benchmark-spec.json');
  const browserScript = path.join(path.dirname(SCRIPT), 'review-browser.mjs');
  const [chromiumExecutableSha256, nativeAddonSha256, webEntrySha256, harnessSha256,
    browserHarnessSha256, scenarioFixtureSha256, benchmarkSpecSha256] = await Promise.all([
    hashFile(options.chromiumPath), hashFile(nativeAddon), hashFile(webEntry), hashFile(SCRIPT),
    hashFile(browserScript), hashFile(scenarioFixture), hashFile(benchmarkSpec),
  ]);
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  const datasets = [];
  try {
    for (let index = 0; index < options.sizes.length; index += 1) {
      const size = options.sizes[index];
      if (controller.signal.aborted) {
        datasets.push(failureDataset(size, 'signal_interrupted'));
        continue;
      }
      const dataset = await runDataset(options, size, controller.signal);
      datasets.push(dataset);
      if (dataset.failureCode === 'cleanup_unproven') {
        for (const unattemptedSize of options.sizes.slice(index + 1)) {
          const unattempted = failureDataset(unattemptedSize, 'not_attempted_cleanup_unproven');
          unattempted.status = 'unproven';
          unattempted.cleanupStatus = 'unproven';
          datasets.push(unattempted);
        }
        break;
      }
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
  const report = {
    schemaVersion: 1, benchmark: 'merchant-intelligence-review-ui', measuredAt: new Date().toISOString(),
    status: reportStatus(datasets),
    configuration: { scenarioId: SCENARIO_ID, scenarioDate: SCENARIO_DATE, sizes: options.sizes,
      warmups: options.warmups, iterations: options.iterations, deadlineMs: options.deadlineMs,
      datasetDeadlineMs: options.datasetDeadlineMs, generatedLoad: 'categorized modest USD transaction history only',
      measurementLabel: 'warmed same-runtime repeated physical Sync-to-correlated-render; full UI descriptive only' },
    runtime: { node: process.version, platform: process.platform, architecture: process.arch, kernel: os.release(),
      cpuAffinity: affinity.affinity, allowedCpuCount: affinity.allowedCpuCount,
      chromiumVersion: datasets.find((dataset) => dataset.chromiumVersion)?.chromiumVersion ?? null,
      chromiumExecutableSha256, nativeAddonSha256, webEntrySha256, harnessSha256, browserHarnessSha256,
      scenarioFixtureSha256, benchmarkSpecSha256 },
    inputs: { scenarioId: SCENARIO_ID, sourceDate: SCENARIO_DATE,
      generatedLoad: 'categorized modest negative USD history; no generated uncategorized targets',
      qualityLabels: 'none; generated performance source is not merchant quality evidence',
      mappingVersion: 'review-categorized-history/1', sourceCap: MAX_SOURCE_ROWS, queueCap: UI_QUEUE_MAX },
    nativeGates: { latency50kMs: 2000, latency250kMs: 5000, memoryLimitBytes: NATIVE_MEMORY_LIMIT_BYTES,
      source: 'unchanged native aggregate limits; not full-UI thresholds' },
    datasets,
  };
  writeArtifact(options.output, report);
  process.stdout.write(`Review benchmark report written privately; status=${report.status}, datasets=${datasets.length}.\n`);
  if (report.status !== 'completed') process.exitCode = 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT) {
  Promise.resolve().then(() => main(parseArgs(process.argv.slice(2)))).catch((error) => {
    const code = safeFailureCode(error, false);
    process.stderr.write(`Review benchmark stopped: ${code}.\n`);
    process.exitCode = 1;
  });
}
