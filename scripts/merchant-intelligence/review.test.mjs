import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
const nativeFetchBeforeReviewImport = globalThis.fetch;
const review = await import('./review.mjs');
import * as reviewBrowser from './review-browser.mjs';
import { aggregate as aggregateNative } from './current.mjs';
const { aggregate, assertSourceQueueSnapshot, buildTransactions, parseArgs, serializeArtifact, writeArtifact } = review;

test('snapshot publication refuses SDK-declared upload failure', async () => {
  await assert.rejects(
    review.publishActualSnapshot({
      send: async (method) => method === 'load-prefs'
        ? { cloudFileId: 'fixture-budget', groupId: 'previous-group' }
        : { error: { reason: 'network' } },
    }, 'fixture-budget'),
    /actual_budget_snapshot_publication_failed/,
  );
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const merchant = JSON.parse(readFileSync(path.join(ROOT, 'protocol/fixtures/scenarios/merchant.json'), 'utf8')).ledger;
const actualIds = {
  accountId: 'actual-checking', payeeId: 'actual-market', categoryId: 'actual-groceries',
  captureStartDate: '0001-01-01', captureEndDate: '9999-12-31',
  analysisStartDate: '2021-10-04', analysisEndDate: '2026-10-04',
};
const referenceSnapshot = { sourceIds: ['source-a', 'source-b'], queueIds: ['review-a'] };
const fullHistoryAdmission = {
  asOfDate: '2026-10-04',
  sourceAdmission: {
    originalTransactionCount: 23, truncatedCount: 0,
    collections: { transactions: 'complete' },
    accountCoverage: [
      { accountId: 'actual-checking', state: 'complete', startDate: '0001-01-01', endDate: '9999-12-31', currencyState: 'known' },
      { accountId: 'actual-savings', state: 'complete', startDate: '0001-01-01', endDate: '9999-12-31', currencyState: 'known' },
    ],
  },
  coverage: { eligibleCount: 23 },
};
const observation = (elapsedMs, size, overrides = {}) => ({
  status: 'completed', censored: false, elapsedMs, uiSettled: true,
  sourceQueueStable: true, sourceCount: size, originalSourceCount: size, truncatedCount: 0, queueCount: 1,
  asOfDate: '2026-10-04', captureStartDate: '0001-01-01', captureEndDate: '9999-12-31',
  analysisStartDate: '2021-10-04', analysisEndDate: '2026-10-04',
  httpStatusCounts: { syncPost: { 200: 1 }, reviewGet: { 200: 1 }, categoriesGet: { 200: 1 } },
  pageErrorCodes: [], ...overrides,
});
const referenceWarmups = (size) => [observation(1, size), observation(2, size)];
const referenceSamples = (size) => Array.from({ length: 20 }, (_, index) => observation(index + 1, size));
const memoryReading = (rssBytes, highWaterBytes) => ({ rssBytes, highWaterBytes });
const expectedMemory = {
  state: 'observed', approximate: true,
  scope: 'owned Actual and web entry processes only; prepared-state baseline through first population, warmups, and repeated Sync; excludes descendants, browser, and host',
  sampleCount: 1, failedReads: 0,
  actual: {
    baseline: memoryReading(1000, 1200), ending: memoryReading(1200, 1800),
    sampledPeakRssBytes: 1400, sampledPeakRssDeltaBytes: 400, lifetimeHighWaterDeltaBytes: 600,
  },
  web: {
    baseline: memoryReading(2000, 2200), ending: memoryReading(1800, 2600),
    sampledPeakRssBytes: 2000, sampledPeakRssDeltaBytes: 0, lifetimeHighWaterDeltaBytes: 400,
  },
  reason: null,
};
const memoryInput = {
  baseline: { actual: memoryReading(1000, 1200), web: memoryReading(2000, 2200) },
  ending: { actual: memoryReading(1200, 1800), web: memoryReading(1800, 2600) },
  samples: [{ actual: memoryReading(1400, 1600), web: memoryReading(1700, 2300) }],
  failedReads: 0,
};
test('owned process memory keeps baseline, ending and sampled RSS/HWM evidence approximate and identity-free', () => {
  const summarize = review.summarizeProcessMemory;
  assert.equal(typeof summarize, 'function');
  assert.deepEqual(summarize(memoryInput), expectedMemory);

  const partial = summarize({
    baseline: { actual: null, web: memoryReading(2000, 2200) },
    ending: { actual: null, web: memoryReading(2100, 2300) },
    samples: [], failedReads: 1,
  });
  assert.equal(partial.state, 'partial');
  assert.equal(partial.actual, null);
  assert.equal(partial.web.baseline.rssBytes, 2000);
  assert.equal(typeof partial.reason, 'string');

  const invalid = summarize({
    baseline: { actual: memoryReading(-1, 0), web: null },
    ending: { actual: null, web: null }, samples: [], failedReads: 0,
  });
  assert.equal(invalid.state, 'unproven');
  assert.equal(invalid.actual, null);
  assert.equal(invalid.web, null);
});

const safeArtifact = {
  schemaVersion: 1,
  benchmark: 'merchant-intelligence-review-ui',
  measuredAt: '2026-10-04T00:00:00.000Z',
  status: 'completed',
  configuration: {
    scenarioId: 'merchant-local-sparse', scenarioDate: '2026-10-04', sizes: [50000],
    warmups: 2, iterations: 20, deadlineMs: 30000, datasetDeadlineMs: 3600000,
    generatedLoad: 'categorized modest USD transaction history only',
    measurementLabel: 'warmed same-runtime repeated physical Sync-to-correlated-render; full UI descriptive only',
  },
  runtime: {
    node: 'v22.0.0', platform: 'linux', architecture: 'x64', kernel: '6.8.0',
    cpuAffinity: '0-1', allowedCpuCount: 2, chromiumVersion: 'Chrome/145.0.0.0',
    chromiumExecutableSha256: `sha256:${'1'.repeat(64)}`, nativeAddonSha256: `sha256:${'2'.repeat(64)}`,
    webEntrySha256: `sha256:${'3'.repeat(64)}`, harnessSha256: `sha256:${'4'.repeat(64)}`,
    browserHarnessSha256: `sha256:${'5'.repeat(64)}`, scenarioFixtureSha256: `sha256:${'6'.repeat(64)}`,
    benchmarkSpecSha256: `sha256:${'7'.repeat(64)}`,
  },
  inputs: {
    scenarioId: 'merchant-local-sparse', sourceDate: '2026-10-04',
    generatedLoad: 'categorized modest negative USD history; no generated uncategorized targets',
    qualityLabels: 'none; generated performance source is not merchant quality evidence',
    mappingVersion: 'review-categorized-history/1', sourceCap: 250000, queueCap: 50,
  },
  nativeGates: { latency50kMs: 2000, latency250kMs: 5000, memoryLimitBytes: 536870912, source: 'unchanged native limits' },
  datasets: [{
    originGuardStatus: 403,
    originGuardQueueUnchanged: true,
    size: 50000,
    status: 'completed',
    cleanupStatus: 'completed',
    source: { count: 50000, originalCount: 50000, retainedCount: 50000, truncatedCount: 0,
      rawActualRowCount: 50000, startingBalanceCount: 0, splitParentCount: 0, splitChildCount: 0,
      excludedRawRowCount: 0, baselineCount: 3, appendHeadroom: 49997, generatedHistoryCount: 49997,
      asOfDate: '2026-10-04', captureStartDate: '0001-01-01', captureEndDate: '9999-12-31',
      analysisStartDate: '2021-10-04', analysisEndDate: '2026-10-04',
      actualReadbackIdsSha256: `sha256:${'d'.repeat(64)}`, exactReadback: true,
      independentPublishedCapture: true, collectionsComplete: true },
    queue: { count: 1, persistedCount: 1, visibleCount: 1, maximumUiCount: 50,
      idsSha256: `sha256:${'e'.repeat(64)}`, stable: true },
    money: { currency: 'USD', generatedMinorUnits: '-100', accountBalanceBeforeMinorUnits: 1000,
      accountBalanceAfterMinorUnits: 900, balanceCheck: true },
    firstPopulation: { status: 'completed', elapsedMs: 10, sourceCount: 50000,
      candidateCount: 1, persistedCount: 1, visibleCount: 1, queueCount: 1,
      persistedAddedCount: 1, persistedRemovedCount: 0,
      httpStatusCounts: { syncPost: { 200: 1 }, reviewGet: { 200: 1 }, categoriesGet: { 200: 1 } },
      pageErrorCodes: [], pageErrorCounts: { network_error: 0, runtime_exception: 0, console_error: 0 },
      queueFingerprint: `sha256:${'b'.repeat(64)}`, currentItemFingerprint: `sha256:${'c'.repeat(64)}` },
    warmups: referenceWarmups(50000),
    samples: referenceSamples(50000),
    completedWarmups: 2, attemptedSamples: 20, completedSamples: 20, failedSamples: 0, censoredSamples: 0,
    p95ElapsedMs: 19, referenceStatus: 'descriptive', uiThresholdMs: null,
    memory: expectedMemory,
    uiProof: {
      screenshotFileName: 'review-reference-ui.png',
      screenshotSha256: `sha256:${'a'.repeat(64)}`,
      queueFingerprint: `sha256:${'b'.repeat(64)}`,
      currentItemFingerprint: `sha256:${'c'.repeat(64)}`,
      httpStatusCounts: { syncPost: { 200: 1 }, reviewGet: { 200: 1 }, categoriesGet: { 200: 1 } },
      pageErrorCodes: [],
      pageErrorCounts: { network_error: 0, runtime_exception: 0, console_error: 0 },
    },
  }],
};

test('full CLI report accepts bounded numeric configuration and records the foreign-origin guard proof', () => {
  const report = JSON.parse(serializeArtifact(safeArtifact));
  assert.deepEqual(report.configuration.sizes, [50000]);
  assert.equal(report.configuration.warmups, 2);
  assert.equal(report.configuration.iterations, 20);
  assert.equal(report.datasets[0].referenceStatus, 'descriptive');
  assert.equal(report.datasets[0].originGuardStatus, 403);
  assert.equal(report.datasets[0].originGuardQueueUnchanged, true);
});
test('CLI parsing accepts explicit bounded reference controls and rejects unsafe sizes or external CDP', () => {
  const options = parseArgs([
    '--sizes', '50000,250000', '--warmups', '2', '--iterations', '20', '--deadline-ms', '30000',
    '--dataset-deadline-ms', '3600000', '--chromium-path', '/opt/google/chrome/chrome',
    '--output', '/tmp/review-reference.json',
  ]);
  assert.deepEqual(options.sizes, [50000, 250000]);
  assert.equal(options.warmups, 2);
  assert.equal(options.iterations, 20);
  assert.equal(options.deadlineMs, 30000);
  assert.equal(options.datasetDeadlineMs, 3600000);
  for (const args of [
    ['--sizes', '0'], ['--sizes', '50000,250001'], ['--sizes', '250001'],
    ['--cdp-url', 'ws://203.0.113.10:9222/devtools/browser/remote'],
  ]) assert.throws(() => parseArgs(args));
});
test('captured Actual SDK fetch aborts a real in-flight loopback request before shutdown', { timeout: 10000 }, async () => {
  const requireScenario = createRequire(path.join(ROOT, 'packages/scenario-kit/package.json'));
  const actualApi = await import(pathToFileURL(requireScenario.resolve('@actual-app/api')).href);
  const dataDir = mkdtempSync(path.join(tmpdir(), 'balanceframe-actual-abort-'));
  const server = createServer();
  let resolveRequest;
  let resolveResponseClosed;
  const requestSeen = new Promise((resolve) => { resolveRequest = resolve; });
  const responseClosed = new Promise((resolve) => { resolveResponseClosed = resolve; });
  let response;
  server.on('request', (request, currentResponse) => {
    request.resume();
    if (request.url !== '/info') {
      currentResponse.statusCode = 404;
      currentResponse.end();
      return;
    }
    response = currentResponse;
    currentResponse.once('close', resolveResponseClosed);
    resolveRequest(request);
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const controller = new AbortController();
  const nativeFetch = nativeFetchBeforeReviewImport;
  let initialized = false;
  let operation;
  let scopedOperation;
  let abortProven = false;
  const within = (promise, timeoutMs) => {
    let timer;
    return Promise.race([
      promise,
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('actual_abort_timeout')), timeoutMs); }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    await actualApi.init({
      dataDir, serverURL: `http://127.0.0.1:${server.address().port}`, verbose: false,
    });
    initialized = true;
    scopedOperation = review.withActualFetchSignal(controller.signal, async () => {
      operation = actualApi.getServerVersion();
      await within(requestSeen, 2000);
      controller.abort();
      const result = await within(operation, 2000);
      assert.deepEqual(result, { error: 'network-failure' });
      await within(responseClosed, 2000);
    });
    await within(scopedOperation, 4000);
    abortProven = true;
    assert.equal(globalThis.fetch, nativeFetch);
  } finally {
    controller.abort();
    if (!abortProven) server.closeAllConnections();
    if (scopedOperation) await scopedOperation.catch(() => {});
    if (operation) await operation.catch(() => {});
    if (response && !abortProven) await responseClosed;
    if (initialized) await actualApi.shutdown();
    await new Promise((resolve) => server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  }
});
test('dataset deadline remains active after first population and awaits aborted owned I/O cleanup', { timeout: 5000 }, async () => {
  const server = createServer();
  let closeStalledResponse;
  const stalledResponseClosed = new Promise((resolve) => { closeStalledResponse = resolve; });
  let stalledResponseClosedObserved = false;
  let stalledRequestObserved = false;
  server.on('request', (request, response) => {
    request.resume();
    if (request.url === '/initial') {
      response.writeHead(204);
      response.end();
      return;
    }
    if (request.url === '/stalled') {
      stalledRequestObserved = true;
      response.once('close', () => { stalledResponseClosedObserved = true; closeStalledResponse(); });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const watchdogController = new AbortController();
  const watchdog = setTimeout(() => watchdogController.abort(), 1000);
  let initialPopulationCompleted = false;
  let cleanupSettled = false;
  let operationSettled = false;
  const serverUrl = `http://127.0.0.1:${server.address().port}`;
  try {
    const result = await review.withDatasetDeadline(200, watchdogController.signal,
      async ({ signal, deadlineExpired }) => {
        const initial = await fetch(`${serverUrl}/initial`, { signal });
        assert.equal(initial.status, 204);
        initialPopulationCompleted = true;
        try {
          await fetch(`${serverUrl}/stalled`, { signal });
          return 'completed';
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 20));
          cleanupSettled = true;
          return deadlineExpired() ? 'deadline' : 'external';
        } finally {
          operationSettled = true;
        }
      });
    assert.equal(result, 'deadline');
    assert.equal(initialPopulationCompleted, true);
    assert.equal(stalledRequestObserved, true);
    await stalledResponseClosed;
    assert.equal(stalledResponseClosedObserved, true);
    assert.equal(cleanupSettled, true);
    assert.equal(operationSettled, true);
  } finally {
    clearTimeout(watchdog);
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

test('finalized dataset JSON records cancellation after awaited cleanup without losing completed evidence', { timeout: 5000 }, async (t) => {
  for (const mode of ['deadline', 'external']) {
    await t.test(mode, async () => {
      let cleanupResponse;
      const server = createServer((_request, response) => {
        cleanupResponse = response;
        response.writeHead(200, { 'content-type': 'text/plain' });
        response.flushHeaders();
        response.write('cleanup-open');
      });
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', resolve);
      });
      const pendingResponse = await fetch(`http://127.0.0.1:${server.address().port}/cleanup`);
      const heldResponse = cleanupResponse;
      const externalController = new AbortController();
      let externalTimer;
      let cleanupStarted = false;
      let cleanupSettled = false;
      try {
        const serialized = await review.withDatasetDeadline(
          mode === 'deadline' ? 25 : 1000,
          externalController.signal,
          async (outcome) => {
            const dataset = structuredClone(safeArtifact.datasets[0]);
            const artifact = structuredClone(safeArtifact);
            cleanupStarted = true;
            outcome.signal.addEventListener('abort', () => heldResponse.end(), { once: true });
            if (mode === 'external') externalTimer = setTimeout(() => externalController.abort(), 25);
            await pendingResponse.text();
            await new Promise((resolve) => {
              server.close(resolve);
              server.closeIdleConnections();
            });
            cleanupSettled = true;
            artifact.datasets = [review.finalizeDatasetOutcome(dataset, false, outcome)];
            artifact.status = dataset.status === 'completed' ? 'completed' : 'unproven';
            return review.serializeArtifact(artifact);
          },
        );
        const dataset = JSON.parse(serialized).datasets[0];
        assert.equal(cleanupStarted, true);
        assert.equal(cleanupSettled, true);
        assert.equal(dataset.status, 'failed');
        assert.equal(dataset.cleanupStatus, 'completed');
        assert.equal(dataset.failureCode, mode === 'deadline' ? 'dataset_deadline_exceeded' : 'signal_interrupted');
        assert.equal(dataset.p95ElapsedMs, null);
        assert.equal(dataset.referenceStatus, 'unproven');
        assert.equal(dataset.completedSamples, 20);
        assert.equal(dataset.firstPopulation.status, 'completed');
        for (const field of ['sourceCount', 'candidateCount', 'persistedCount', 'visibleCount', 'queueCount',
          'persistedAddedCount', 'persistedRemovedCount']) {
          assert.equal(dataset.firstPopulation[field], safeArtifact.datasets[0].firstPopulation[field]);
        }
        assert.equal(dataset.firstPopulation.queueFingerprint, safeArtifact.datasets[0].firstPopulation.queueFingerprint);
        assert.equal(dataset.firstPopulation.currentItemFingerprint, safeArtifact.datasets[0].firstPopulation.currentItemFingerprint);
      } finally {
        clearTimeout(externalTimer);
        if (heldResponse && !heldResponse.writableEnded) heldResponse.end();
        if (!pendingResponse.bodyUsed) await pendingResponse.text();
        if (server.listening) {
          await new Promise((resolve) => {
            server.close(resolve);
            server.closeIdleConnections();
          });
        }
      }
    });
  }
});

test('terminal cancellation overrides short-reference and failed observations after cleanup', () => {
  for (const status of ['unproven', 'failed']) {
    for (const mode of ['deadline', 'external']) {
      const dataset = structuredClone(safeArtifact.datasets[0]);
      dataset.status = status;
      dataset.failureCode = status === 'unproven' ? 'review_ui_unproven' : 'review_sync_failed';
      dataset.p95ElapsedMs = null;
      dataset.referenceStatus = 'unproven';
      const result = review.finalizeDatasetOutcome(dataset, false, {
        signal: AbortSignal.abort(), deadlineExpired: () => mode === 'deadline',
      });
      assert.equal(result.status, 'failed');
      assert.equal(result.failureCode, mode === 'deadline' ? 'dataset_deadline_exceeded' : 'signal_interrupted');
      assert.equal(result.cleanupStatus, 'completed');
      assert.equal(result.queue.stable, false);
      assert.equal(result.firstPopulation.status, 'completed');
      assert.equal(result.firstPopulation.elapsedMs, safeArtifact.datasets[0].firstPopulation.elapsedMs);
      assert.equal(result.p95ElapsedMs, null);
      assert.equal(result.referenceStatus, 'unproven');
    }
  }
});

test('cleanup uncertainty remains the serialized dataset outcome after cancellation', () => {
  const artifact = structuredClone(safeArtifact);
  artifact.status = 'unproven';
  artifact.datasets[0] = review.finalizeDatasetOutcome(artifact.datasets[0], true, {
    deadlineExpired: () => true, deadlineAt: 0, signal: { aborted: true },
  });
  const dataset = JSON.parse(review.serializeArtifact(artifact)).datasets[0];
  assert.equal(dataset.status, 'failed');
  assert.equal(dataset.cleanupStatus, 'unproven');
  assert.equal(dataset.failureCode, 'cleanup_unproven');
  assert.equal(dataset.p95ElapsedMs, null);
  assert.equal(dataset.referenceStatus, 'unproven');
});


test('source admission accepts complete all-history Actual coverage and derives a separate five-year analysis window', () => {
  const result = review.sourceAdmission(fullHistoryAdmission);
  assert.equal(result.sourceCount, 23);
  assert.equal(result.originalSourceCount, 23);
  assert.equal(result.retainedCount, 23);
  assert.equal(result.truncatedCount, 0);
  assert.equal(result.eligibleCount, 23);
  assert.equal(result.collectionsComplete, true);
  assert.equal(result.asOfDate, '2026-10-04');
  assert.equal(result.captureStartDate, '0001-01-01');
  assert.equal(result.captureEndDate, '9999-12-31');
  assert.equal(result.analysisStartDate, '2021-10-04');
  assert.equal(result.analysisEndDate, '2026-10-04');
});

test('source admission rejects invalid civil dates, reversed capture bounds, and an unrepresentable analysis horizon', () => {
  const invalid = [
    { ...fullHistoryAdmission, asOfDate: '2026-02-30' },
    { ...fullHistoryAdmission, sourceAdmission: { ...fullHistoryAdmission.sourceAdmission,
      accountCoverage: [{ ...fullHistoryAdmission.sourceAdmission.accountCoverage[0], startDate: '0001-02-29' }] } },
    { ...fullHistoryAdmission, sourceAdmission: { ...fullHistoryAdmission.sourceAdmission,
      accountCoverage: [{ ...fullHistoryAdmission.sourceAdmission.accountCoverage[0], startDate: '9999-12-31', endDate: '0001-01-01' }] } },
    { ...fullHistoryAdmission, asOfDate: '0001-01-01' },
  ];
  for (const admission of invalid) assert.throws(() => review.sourceAdmission(admission));
});

test('review API queue parsing follows the admitted nested DTO and preserves current item identity/display proof', () => {
  const transaction = merchant.transactions.find(({ id }) => id === 'synthetic-holdout-000-02');
  const item = {
    reviewItem: { id: 'review-item-1', transactionId: 'actual-row-17', status: 'pending_review' },
    evidence: { normalizedMerchant: '', originalImportedName: transaction.importedPayee, money: transaction.amount },
  };
  const parseQueue = (items, total = items.length) => reviewBrowser.parseApiBody({ kind: 'reviewGet' },
    JSON.stringify({ status: 'ok', result: { items, total } }));
  const result = parseQueue([item]);
  assert.equal(result.valid, true);
  assert.deepEqual(result.queueIds, ['actual-row-17']);
  assert.deepEqual(result.currentItem, {
    transactionId: 'actual-row-17', normalizedMerchant: '', originalImportedName: transaction.importedPayee,
    amount: Number(transaction.amount.minorUnits), currency: transaction.amount.currency,
  });
  assert.equal(parseQueue([{ ...item, transactionId: 'unused-top-level-id' }]).valid, true);
  assert.deepEqual(parseQueue([{ ...item, transactionId: 'unused-top-level-id' }]).queueIds, ['actual-row-17']);
  for (const minorUnits of ['0', '9007199254740991', '-9007199254740991']) {
    const boundary = parseQueue([{ ...item, evidence: { ...item.evidence,
      money: { ...transaction.amount, minorUnits } } }]);
    assert.equal(boundary.valid, true);
    assert.equal(boundary.currentItem.amount, Number(minorUnits));
  }
  for (const invalidItem of [
    { ...item, reviewItem: null },
    { ...item, reviewItem: { id: item.reviewItem.id } },
    { ...item, reviewItem: { ...item.reviewItem, transactionId: '' } },
    { ...item, evidence: { ...item.evidence, money: null } },
    { ...item, evidence: { ...item.evidence, money: { ...transaction.amount, minorUnits: '9007199254740992' } } },
    { ...item, evidence: { ...item.evidence, money: { ...transaction.amount, minorUnits: '-9007199254740992' } } },
    { ...item, evidence: { ...item.evidence, money: { ...transaction.amount, minorUnits: '-34.607' } } },
    { ...item, evidence: { ...item.evidence, money: { ...transaction.amount, currency: null } } },
  ]) assert.equal(parseQueue([invalidItem]).valid, false);
  assert.equal(parseQueue([item, item]).valid, false);
  assert.equal(parseQueue([], 0).valid, true);
});


test('Actual transaction load stays deterministic, categorized, and within the five-year analysis horizon', () => {
  const original = JSON.stringify(merchant);
  const rows = buildTransactions(merchant, 500, actualIds);
  assert.deepEqual(rows, buildTransactions(merchant, 500, actualIds));
  assert.equal(JSON.stringify(merchant), original);
  assert.equal(rows.length, 500);
  assert(rows.every((row) => row.payee === actualIds.payeeId && row.category === actualIds.categoryId && row.cleared === true));
  assert(rows.every((row) => Number.isSafeInteger(row.amount) && row.amount < 0 && Math.abs(row.amount) <= 10000));
  assert(rows.every((row) => row.date >= actualIds.analysisStartDate && row.date <= actualIds.analysisEndDate));
  const importedIds = rows.map((row) => row.imported_id);
  assert(importedIds.every((id) => typeof id === 'string' && id.length > 0));
  assert.equal(new Set(importedIds).size, rows.length);
  assert(importedIds.every((id) => !merchant.transactions.some((row) => row.importedId === id)));
  assert.throws(() => buildTransactions(merchant, 0, actualIds));
  assert.throws(() => buildTransactions(merchant, 250001, actualIds));
  assert.throws(() => buildTransactions(merchant, 1, { ...actualIds, analysisStartDate: '2026-10-05' }));
  assert.throws(() => buildTransactions(merchant, 1, { ...actualIds, analysisStartDate: '2021-02-29' }));
  assert.throws(() => buildTransactions(merchant, 1, {}));
});

test('source and persisted queue readbacks require exact unique ID sets, independent of order', () => {
  assert.deepEqual(assertSourceQueueSnapshot(referenceSnapshot, {
    sourceIds: ['source-b', 'source-a'], queueIds: ['review-a'],
  }), { sourceCount: 2, queueCount: 1 });
  for (const changed of [
    { sourceIds: ['source-a', 'source-extra'], queueIds: ['review-a'] },
    { sourceIds: ['source-a', 'source-a'], queueIds: ['review-a'] },
    { sourceIds: ['source-a', 'source-b'], queueIds: ['review-a', 'review-a'] },
    { sourceIds: ['source-a', 'source-b'], queueIds: [] },
  ]) assert.throws(() => assertSourceQueueSnapshot(referenceSnapshot, changed));
});

test('native financial readbacks prove every baseline row, exact generated delta, and all-account balances in both captures', () => {
  const expected = {
    sourceIds: ['baseline-a', 'baseline-b', 'generated-a'], queueIds: ['target-a'],
    financial: {
      baselineRows: [
        { id: 'baseline-a', accountId: 'account-a', amount: -100 },
        { id: 'baseline-b', accountId: 'account-b', amount: -200 },
      ],
      baselineBalances: new Map([['account-a', 1000], ['account-b', 2000]]),
      appendAccountId: 'account-a', generatedMinorUnits: -25n,
    },
  };
  const observed = {
    sourceIds: expected.sourceIds, queueIds: expected.queueIds,
    financial: {
      rows: [
        ...expected.financial.baselineRows,
        { id: 'generated-a', accountId: 'account-a', amount: -25 },
      ],
      balances: new Map([['account-a', 975], ['account-b', 2000]]),
    },
  };
  assert.deepEqual(assertSourceQueueSnapshot(expected, observed), { sourceCount: 3, queueCount: 1 });

  const compensatingAmountChanges = structuredClone(observed);
  compensatingAmountChanges.financial.rows[0].amount = -101;
  compensatingAmountChanges.financial.rows[1].amount = -199;
  assert.throws(() => assertSourceQueueSnapshot(expected, compensatingAmountChanges));

  const untouchedAccountBalanceDrift = structuredClone(observed);
  untouchedAccountBalanceDrift.financial.balances.set('account-b', 1999);
  assert.throws(() => assertSourceQueueSnapshot(expected, untouchedAccountBalanceDrift));

  const appendAccountBalanceDrift = structuredClone(observed);
  appendAccountBalanceDrift.financial.balances.set('account-a', 976);
  assert.throws(() => assertSourceQueueSnapshot(expected, appendAccountBalanceDrift));
});

test('baseline native facts cannot drift while source IDs and money remain equal', () => {
  const canonical = merchant.transactions[0];
  const row = {
    id: canonical.id, accountId: actualIds.accountId,
    amount: Number(canonical.amount.minorUnits), date: canonical.date,
    payee: canonical.payeeId, category: canonical.categoryId,
    imported_id: canonical.id, imported_payee: canonical.importedPayee,
    notes: canonical.notes, cleared: canonical.cleared, reconciled: canonical.reconciled,
    parent_id: null, transfer_id: null, is_parent: false,
  };
  const balance = Number(merchant.accounts[0].importedBalance.minorUnits);
  const expected = {
    sourceIds: [row.id], queueIds: [],
    financial: { baselineRows: [row], baselineBalances: new Map([[actualIds.accountId, balance]]),
      appendAccountId: actualIds.accountId, generatedMinorUnits: 0n },
  };
  const observed = {
    sourceIds: [row.id], queueIds: [],
    financial: { rows: [{ ...row }], balances: new Map([[actualIds.accountId, balance]]) },
  };
  assert.deepEqual(assertSourceQueueSnapshot(expected, observed), { sourceCount: 1, queueCount: 0 });
  for (const [field, changed] of [
    ['date', '2000-01-01'], ['payee', 'different-payee'], ['category', 'different-category'],
    ['imported_id', 'different-import'], ['imported_payee', 'different-merchant'],
    ['notes', 'different-note'], ['cleared', !row.cleared], ['reconciled', !row.reconciled],
    ['parent_id', 'different-parent'], ['transfer_id', 'different-transfer'], ['is_parent', true],
  ]) {
    const drift = structuredClone(observed);
    drift.financial.rows[0][field] = changed;
    assert.throws(() => assertSourceQueueSnapshot(expected, drift), `changed ${field}`);
  }
});

test('first-population queue and current-item proof are bound to the canonical fixture', () => {
  const canonicalTarget = merchant.transactions.find(({ id }) => id === 'synthetic-holdout-000-02');
  assert(canonicalTarget);
  const nativeTargetId = 'actual-holdout-000-02';
  const target = {
    transactionId: nativeTargetId, accountId: actualIds.accountId,
    amount: Number(canonicalTarget.amount.minorUnits), currency: canonicalTarget.amount.currency,
    originalImportedName: canonicalTarget.importedPayee, nativeImportedName: canonicalTarget.importedPayee,
  };
  const expected = {
    sourceIds: [nativeTargetId], queueIds: [nativeTargetId],
    canonicalQueueIds: [nativeTargetId], currentItem: target,
  };
  assert.deepEqual(assertSourceQueueSnapshot(expected, {
    sourceIds: [nativeTargetId], queueIds: [nativeTargetId], currentItem: { ...target },
  }), { sourceCount: 1, queueCount: 1 });

  for (const { adoptedQueueIds, actualQueueIds, currentItem } of [
    { adoptedQueueIds: ['wrong-native-id'], actualQueueIds: ['wrong-native-id'], currentItem: { ...target, transactionId: 'wrong-native-id' } },
    { adoptedQueueIds: [nativeTargetId, 'history-native-id'], actualQueueIds: [nativeTargetId, 'history-native-id'], currentItem: { ...target } },
    { adoptedQueueIds: [nativeTargetId], actualQueueIds: [nativeTargetId], currentItem: { ...target, transactionId: 'wrong-native-id' } },
    { adoptedQueueIds: [nativeTargetId], actualQueueIds: [nativeTargetId], currentItem: { ...target, accountId: 'other-account' } },
    { adoptedQueueIds: [nativeTargetId], actualQueueIds: [nativeTargetId], currentItem: { ...target, amount: target.amount + 1 } },
    { adoptedQueueIds: [nativeTargetId], actualQueueIds: [nativeTargetId], currentItem: { ...target, currency: 'CAD' } },
    { adoptedQueueIds: [nativeTargetId], actualQueueIds: [nativeTargetId], currentItem: { ...target, originalImportedName: 'other merchant' } },
    { adoptedQueueIds: [nativeTargetId], actualQueueIds: [nativeTargetId], currentItem: { ...target, nativeImportedName: 'other merchant' } },
  ]) assert.throws(() => assertSourceQueueSnapshot({ ...expected, queueIds: adoptedQueueIds }, {
    sourceIds: [nativeTargetId], queueIds: actualQueueIds, currentItem,
  }));
});

test('only two completed warmups and 20 settled, exact-source UI samples yield descriptive nearest-rank p95', () => {
  const size = 50000;
  const warmups = referenceWarmups(size);
  const samples = referenceSamples(size);
  const summary = aggregate({ size, warmups, samples });
  assert.equal(summary.completedWarmups, 2);
  assert.equal(summary.completedSamples, 20);
  assert.equal(summary.p95ElapsedMs, 19);
  assert.equal(summary.referenceStatus, 'descriptive');
  assert.equal(summary.uiThresholdMs, null);

  for (const input of [
    { warmups: warmups.slice(0, 1), samples },
    { warmups: [...warmups, observation(3, size)], samples },
    { warmups, samples: samples.slice(0, 19) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, uiSettled: false } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, sourceQueueStable: false } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample,
      asOfDate: '2026-10-05', analysisStartDate: '2021-10-05', analysisEndDate: '2026-10-05' } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, sourceCount: size - 1, originalSourceCount: size - 1 } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, originalSourceCount: size - 1 } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, truncatedCount: 1 } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, queueCount: 51 } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, queueCount: 2 } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, elapsedMs: Number.NaN } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, elapsedMs: Number.POSITIVE_INFINITY } : sample) },
    { warmups, samples: samples.map((sample, index) => index === 19 ? { ...sample, elapsedMs: -1 } : sample) },
  ]) {
    const incomplete = aggregate({ size, ...input });
    assert.equal(incomplete.p95ElapsedMs, null);
    assert.equal(incomplete.referenceStatus, 'unproven');
  }
});

test('censored and failed samples remain incomplete and cannot produce a reference p95', () => {
  const size = 250000;
  for (const failed of [
    observation(null, size, { status: 'timeout', censored: true }),
    observation(null, size, { status: 'error' }),
  ]) {
    const samples = referenceSamples(size);
    samples[19] = failed;
    const summary = aggregate({ size, warmups: referenceWarmups(size), samples });
    assert.equal(summary.p95ElapsedMs, null);
    assert.equal(summary.referenceStatus, 'unproven');
    assert.equal(summary.attemptedSamples, 20);
  }
});
test('CDP command timeouts are censored observations, not ordinary failed samples', () => {
  assert.deepEqual(review.classifyObservationFailure(new Error('cdp_command_timeout')),
    { status: 'timeout', censored: true });
  assert.deepEqual(review.classifyObservationFailure(new Error('review_sync_failed')),
    { status: 'error', censored: false });
});

test('dataset-deadline cancellation is censored while external interruption remains an error', () => {
  const interrupted = Object.assign(new Error('signal_interrupted'), { code: 'signal_interrupted' });
  assert.deepEqual(review.classifyObservationFailure(interrupted, true), { status: 'timeout', censored: true });
  assert.deepEqual(review.classifyObservationFailure(interrupted, false), { status: 'error', censored: false });
});

test('a post-population queue mismatch revokes whole-run stability but preserves its receipt', () => {
  const receipt = structuredClone(safeArtifact.datasets[0].firstPopulation);
  const dataset = {
    status: 'unproven', failureCode: 'source_queue_invariant_failed',
    queue: { ...safeArtifact.datasets[0].queue, stable: true },
    firstPopulation: receipt,
  };
  review.finalizeDatasetOutcome(dataset, false);
  assert.equal(dataset.queue.stable, false);
  assert.deepEqual(dataset.firstPopulation, receipt);
});

test('native thresholds stay intact while full Review remains descriptive without an invented UI target', () => {
  const nativeSamples = Array.from({ length: 20 }, () => ({ status: 'completed', censored: false,
    elapsedMs: 10, jsSerializationMs: 1, nativeElapsedMs: 8, jsResponseParseMs: 1,
    memory: { proven: true, incrementalPeakRssBytes: 0 } }));
  assert.equal(aggregateNative(nativeSamples, 20, 50000, 2).gates.latencyLimitMs, 2000);
  assert.equal(aggregateNative(nativeSamples, 20, 250000, 2).gates.latencyLimitMs, 5000);
  assert.equal(aggregateNative(nativeSamples, 20, 50000, 2).gates.memoryLimitBytes, 512 * 1024 * 1024);
  assert.equal(aggregate({ size: 50000, warmups: referenceWarmups(50000), samples: referenceSamples(50000) }).uiThresholdMs, null);
});

test('a later dataset failure preserves completed first-population evidence in a strict report', () => {
  const receipt = structuredClone(safeArtifact.datasets[0].firstPopulation);
  const error = new Error('review_sync_failed');
  error.browserDiagnostics = { httpStatusCounts: { syncPost: { 500: 1 } }, pageErrorCodes: ['network_error'] };
  const preserved = review.firstPopulationAfterFailure(receipt, error);
  const report = structuredClone(safeArtifact);
  report.status = 'partial';
  report.datasets[0].status = 'failed';
  report.datasets[0].failureCode = 'review_sync_failed';
  report.datasets[0].referenceStatus = 'unproven';
  report.datasets[0].p95ElapsedMs = null;
  report.datasets[0].firstPopulation = preserved;
  const failed = JSON.parse(serializeArtifact(report)).datasets[0].firstPopulation;
  assert.equal(failed.status, 'completed');
  assert.equal(failed.elapsedMs, receipt.elapsedMs);
  assert.equal(failed.sourceCount, 50000);
  assert.equal(failed.candidateCount, 1);
  assert.equal(failed.persistedCount, 1);
  assert.equal(failed.visibleCount, 1);
  assert.equal(failed.queueCount, 1);
  assert.equal(failed.persistedAddedCount, 1);
  assert.equal(failed.persistedRemovedCount, 0);
  assert.equal(failed.queueFingerprint, receipt.queueFingerprint);
  assert.equal(failed.currentItemFingerprint, receipt.currentItemFingerprint);
  assert.deepEqual(failed.httpStatusCounts, receipt.httpStatusCounts);
  assert.deepEqual(failed.pageErrorCounts, receipt.pageErrorCounts);
});
test('artifact serialization rejects secrets and output is exclusive, private, and symlink-safe', (t) => {
  const serialized = serializeArtifact(safeArtifact);
  const failureAfterPopulation = structuredClone(safeArtifact);
  failureAfterPopulation.status = 'partial';
  failureAfterPopulation.datasets[0].status = 'failed';
  failureAfterPopulation.datasets[0].failureCode = 'review_screenshot_unavailable';
  failureAfterPopulation.datasets[0].referenceStatus = 'unproven';
  failureAfterPopulation.datasets[0].p95ElapsedMs = null;
  const failedReport = JSON.parse(serializeArtifact(failureAfterPopulation));
  assert.equal(failedReport.datasets[0].firstPopulation.queueFingerprint, safeArtifact.datasets[0].firstPopulation.queueFingerprint);
  assert.equal(failedReport.datasets[0].firstPopulation.currentItemFingerprint, safeArtifact.datasets[0].firstPopulation.currentItemFingerprint);
  const proof = JSON.parse(serialized).datasets[0].uiProof;
  assert.equal(proof.screenshotSha256, safeArtifact.datasets[0].uiProof.screenshotSha256);
  assert.equal(proof.queueFingerprint, safeArtifact.datasets[0].uiProof.queueFingerprint);
  assert.equal(proof.currentItemFingerprint, safeArtifact.datasets[0].uiProof.currentItemFingerprint);
  assert.deepEqual(proof.httpStatusCounts, { syncPost: { 200: 1 }, reviewGet: { 200: 1 }, categoriesGet: { 200: 1 } });
  assert.deepEqual(proof.pageErrorCodes, []);
  assert.deepEqual(proof.pageErrorCounts, { network_error: 0, runtime_exception: 0, console_error: 0 });
  const incompleteCleanup = structuredClone(safeArtifact);
  incompleteCleanup.datasets[0].cleanupStatus = 'unproven';
  assert.throws(() => serializeArtifact(incompleteCleanup));
  assert.equal(proof.screenshotFileName, 'review-reference-ui.png');
  assert.throws(() => serializeArtifact({ ...safeArtifact, actualSecretKey: 'harmless-test-sentinel' }));
  assert.throws(() => serializeArtifact({ ...safeArtifact, unapprovedDiagnostic: 'private manifest' }));
  const reportWithPid = structuredClone(safeArtifact);
  reportWithPid.datasets[0].memory.actual.pid = 321;
  assert.throws(() => serializeArtifact(reportWithPid));
  const reportWithInvalidMemory = structuredClone(safeArtifact);
  reportWithInvalidMemory.datasets[0].memory.actual.sampledPeakRssBytes = -1;
  assert.throws(() => serializeArtifact(reportWithInvalidMemory));
  const changedNativeLimits = structuredClone(safeArtifact);
  changedNativeLimits.nativeGates.latency50kMs += 1;
  assert.throws(() => serializeArtifact(changedNativeLimits));
  const root = mkdtempSync(path.join(tmpdir(), 'review-benchmark-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const reportPath = path.join(root, 'report.json');
  writeArtifact(reportPath, safeArtifact);
  assert.equal(statSync(reportPath).mode & 0o777, 0o600);
  const original = readFileSync(reportPath, 'utf8');
  assert.throws(() => writeArtifact(reportPath, safeArtifact));
  assert.equal(readFileSync(reportPath, 'utf8'), original);

  const targetPath = path.join(root, 'target.json');
  writeFileSync(targetPath, 'untouched');
  const linkPath = path.join(root, 'report-link.json');
  symlinkSync(targetPath, linkPath);
  assert.throws(() => writeArtifact(linkPath, safeArtifact));
  assert.equal(readFileSync(targetPath, 'utf8'), 'untouched');
});
