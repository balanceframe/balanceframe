import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { closeReviewPage, createReviewPage, performSync, captureReviewScreenshot } from './review-browser.mjs';

const merchant = JSON.parse(readFileSync(new URL('../../protocol/fixtures/scenarios/merchant.json', import.meta.url), 'utf8'));
const fixtureMoney = merchant.ledger.transactions.find(({ id }) => id === 'synthetic-holdout-000-02').amount;
const sessionId = 'review-session';
const requestBodies = {
  review: JSON.stringify({ status: 'ok', result: { total: 1, items: [{
    reviewItem: { transactionId: 'fixture-transaction' },
    evidence: { normalizedMerchant: 'Example Merchant', originalImportedName: 'Example Merchant', money: fixtureMoney },
  }] } }),
  categories: JSON.stringify({ status: 'ok', result: { categories: ['groceries'] } }),
  sync: JSON.stringify({ status: 'ok', result: {
    synchronized: true, failed: 0, skipped: 0, transitioned: 1, result: { candidates: [] },
  } }),
};

class ReviewCdpFixture {
  constructor({ initialRuntimeError = false, initialConsoleError = false, failedBudgetSummary = false } = {}) {
    this.listeners = new Map();
    this.bodies = new Map();
    this.initialRuntimeError = initialRuntimeError;
    this.initialConsoleError = initialConsoleError;
    this.failedBudgetSummary = failedBudgetSummary;
    this.syncCount = 0;
    this.timeoutMs = 1000;
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  emit(method, params) {
    for (const listener of this.listeners.get(method) ?? []) listener(params, sessionId);
  }

  emitRequest(requestId, url, method, status, body) {
    this.emit('Network.requestWillBeSent', { requestId, request: { url, method } });
    this.emit('Network.responseReceived', { requestId, response: { status, url } });
    if (body) this.bodies.set(requestId, body);
    this.emit('Network.loadingFinished', { requestId });
  }

  async send(method, params = {}) {
    if (method === 'Target.createTarget') return { targetId: 'review-target' };
    if (method === 'Target.attachToTarget') return { sessionId };
    if (method === 'Network.getResponseBody') return { body: this.bodies.get(params.requestId) };
    if (method === 'Page.navigate') {
      if (this.initialRuntimeError)
        this.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'private runtime error' } });
      if (this.initialConsoleError)
        this.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'private console error' }] });
      if (this.failedBudgetSummary)
        this.emitRequest('budget-summary', 'http://127.0.0.1:4000/api/home/budget-summary?private=query', 'GET', 503);
      this.emitRequest('initial-review', 'http://127.0.0.1:4000/api/review', 'GET', 200, requestBodies.review);
      this.emitRequest('initial-categories', 'http://127.0.0.1:4000/api/review/categories', 'GET', 200, requestBodies.categories);
      return {};
    }
    if (method === 'Runtime.evaluate') {
      if (params.expression.includes('getBoundingClientRect'))
        return { result: { value: { x: 10, y: 20 } } };
      if (params.expression.includes('Admitted source display text'))
        return { result: { value: { syncEnabled: true, currentItemMatches: true, rowCount: 1,
          heading: true, error: false, busy: false } } };
      return { result: { value: { ready: true } } };
    }
    if (method === 'Input.dispatchMouseEvent' && params.type === 'mouseReleased') {
      const sync = ++this.syncCount;
      this.emitRequest(`sync-${sync}`, 'http://127.0.0.1:4000/api/review/sync', 'POST', 200, requestBodies.sync);
      this.emitRequest(`review-${sync}`, 'http://127.0.0.1:4000/api/review', 'GET', 200, requestBodies.review);
      this.emitRequest(`categories-${sync}`, 'http://127.0.0.1:4000/api/review/categories', 'GET', 200,
        requestBodies.categories);
      return {};
    }
    if (method === 'Page.captureScreenshot') return { data: Buffer.from('png').toString('base64') };
    return {};
  }
}

function browser(connection) {
  return { connection, browserContextId: 'review-context', stopped: false };
}

async function pageWith(connection) {
  return createReviewPage(browser(connection), 'http://127.0.0.1:4000/review', 'session=fixture', 1000);
}

async function expectPageFailure(promise, expectedCodes) {
  const outcome = await promise.then((page) => ({ page }), (error) => ({ error }));
  if (outcome.page) await closeReviewPage(outcome.page);
  assert(outcome.error, 'a page with observed errors must not be reported as successful');
  assert.deepEqual(outcome.error.browserDiagnostics?.pageErrorCodes, expectedCodes);
}

test('clean CDP readiness, physical sync, and screenshot remain successful', async () => {
  const page = await pageWith(new ReviewCdpFixture());
  try {
    const result = await performSync(page, { cookieHeader: 'session=fixture',
      expectedQueueIds: ['fixture-transaction'], deadlineMs: 1000 });
    assert.equal(result.status, 'completed');
    assert.deepEqual(result.pageErrorCodes, []);
    assert(Buffer.isBuffer(await captureReviewScreenshot(page, 'Example Merchant')));
  } finally {
    await closeReviewPage(page);
  }
});

test('initial runtime and console errors cannot yield ready-page success', async () => {
  const connection = new ReviewCdpFixture({ initialRuntimeError: true, initialConsoleError: true });
  await expectPageFailure(pageWith(connection), ['runtime_exception', 'console_error']);
});

test('errors between completed sync epochs block a later completed result', async () => {
  const connection = new ReviewCdpFixture();
  const page = await pageWith(connection);
  try {
    const first = await performSync(page, { cookieHeader: 'session=fixture',
      expectedQueueIds: ['fixture-transaction'], deadlineMs: 1000 });
    assert.equal(first.status, 'completed');
    connection.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'private runtime error' } });
    connection.emit('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'private console error' }] });
    await expectPageFailure(performSync(page, { cookieHeader: 'session=fixture',
      expectedQueueIds: ['fixture-transaction'], deadlineMs: 1000 }), ['runtime_exception', 'console_error']);
  } finally {
    await closeReviewPage(page);
  }
});

test('a detached failed budget-summary response blocks initial readiness without exposing its URL', async () => {
  const connection = new ReviewCdpFixture({ failedBudgetSummary: true });
  await expectPageFailure(pageWith(connection), ['network_error']);
});

test('screenshot cannot affirm a page after a lifetime runtime error', async () => {
  const connection = new ReviewCdpFixture();
  const page = await pageWith(connection);
  try {
    connection.emit('Runtime.exceptionThrown', { exceptionDetails: { text: 'private runtime error' } });
    await assert.rejects(captureReviewScreenshot(page, 'Example Merchant'), (error) =>
      error.browserDiagnostics?.pageErrorCodes?.includes('runtime_exception') === true);
  } finally {
    await closeReviewPage(page);
  }
});

test('a missing Chromium interpreter rejects acquisition without an uncaught child error', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'balanceframe-chromium-spawn-test-'));
  chmodSync(root, 0o700);
  const chromiumPath = path.join(root, 'chromium');
  const profilePath = path.join(root, 'profile');
  writeFileSync(chromiumPath, '#!/definitely/missing-browser-interpreter\n', { mode: 0o700 });
  chmodSync(chromiumPath, 0o700);
  const moduleUrl = new URL('./review-browser.mjs', import.meta.url).href;
  const source = `
    import { startOwnedChromium } from ${JSON.stringify(moduleUrl)};
    try {
      await startOwnedChromium({ chromiumPath: ${JSON.stringify(chromiumPath)},
        profilePath: ${JSON.stringify(profilePath)}, timeoutMs: 1000 });
      process.stdout.write(JSON.stringify({ status: 'resolved' }));
      process.exitCode = 1;
    } catch (error) {
      process.stdout.write(JSON.stringify({ status: 'rejected', message: error.message }));
    }
  `;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', source],
      { encoding: 'utf8', timeout: 8000 });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.signal, null);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), { status: 'rejected', message: 'chromium_spawn_failed' });
    assert.equal(result.stderr, '');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
