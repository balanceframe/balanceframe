import { spawn } from 'node:child_process';
import { accessSync, constants, existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
function throwIfAborted(signal) {
  if (signal?.aborted) throw new Error('signal_interrupted');
}

class CdpConnection {
  constructor(socket, timeoutMs) {
    this.socket = socket;
    this.timeoutMs = timeoutMs;
    this.nextId = 1;
    this.pending = new Map();
    this.listeners = new Map();
    socket.addEventListener('message', (event) => this.onMessage(event.data));
    socket.addEventListener('close', () => this.rejectPending());
    socket.addEventListener('error', () => this.rejectPending());
  }

  static async connect(endpoint, timeoutMs, signal) {
    if (signal?.aborted) throw new Error('signal_interrupted');
    const socket = new WebSocket(endpoint);
    await new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        socket.removeEventListener('open', onOpen);
        socket.removeEventListener('error', onError);
        signal?.removeEventListener('abort', onAbort);
      };
      const onOpen = () => { cleanup(); resolve(); };
      const onError = () => { cleanup(); reject(new Error('cdp_connect_failed')); };
      const onAbort = () => {
        cleanup();
        try { socket.close(); } catch { /* Owned Chromium cleanup follows. */ }
        reject(new Error('signal_interrupted'));
      };
      const timer = setTimeout(() => {
        cleanup();
        try { socket.close(); } catch { /* Owned Chromium cleanup follows. */ }
        reject(new Error('cdp_connect_timeout'));
      }, timeoutMs);
      socket.addEventListener('open', onOpen, { once: true });
      socket.addEventListener('error', onError, { once: true });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
    });
    return new CdpConnection(socket, timeoutMs);
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  send(method, params = {}, sessionId, timeoutMs = this.timeoutMs, signal) {
    if (signal?.aborted) return Promise.reject(new Error('signal_interrupted'));
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(new Error('cdp_closed'));
    const timeout = Math.min(this.timeoutMs, timeoutMs);
    if (!Number.isFinite(timeout) || timeout <= 0) return Promise.reject(new Error('cdp_command_timeout'));
    const id = this.nextId++;
    const message = { id, method, params, ...(sessionId ? { sessionId } : {}) };
    return new Promise((resolve, reject) => {
      const cleanup = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        this.pending.delete(id);
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('cdp_command_timeout'));
      }, timeout);
      const onAbort = () => {
        cleanup();
        reject(new Error('signal_interrupted'));
      };
      this.pending.set(id, { resolve, reject, timer, signal, onAbort });
      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) {
        onAbort();
        return;
      }
      try { this.socket.send(JSON.stringify(message)); } catch {
        cleanup();
        reject(new Error('cdp_send_failed'));
      }
    });
  }

  close() {
    if (this.socket.readyState === WebSocket.OPEN || this.socket.readyState === WebSocket.CONNECTING)
      this.socket.close();
    this.rejectPending();
  }

  onMessage(raw) {
    let message;
    try { message = JSON.parse(String(raw)); } catch { return; }
    if (Number.isInteger(message.id)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.onAbort);
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error('cdp_command_failed'));
      else pending.resolve(message.result ?? {});
      return;
    }
    if (typeof message.method !== 'string') return;
    for (const listener of this.listeners.get(message.method) ?? []) {
      try { listener(message.params ?? {}, message.sessionId ?? null); } catch { /* Isolated event observer. */ }
    }
  }

  rejectPending() {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.signal?.removeEventListener('abort', pending.onAbort);
      pending.reject(new Error('cdp_closed'));
    }
    this.pending.clear();
  }
}

function assertPrivateDirectory(directory) {
  const absolute = path.resolve(directory);
  const stat = lstatSync(absolute);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0)
    throw new Error('chromium_profile_not_private');
  return absolute;
}

async function stopChild(child, closed = null) {
  if (!child) return;
  if (!Number.isInteger(child.pid) || child.pid <= 0) {
    await (closed ?? new Promise((resolve) => child.once('close', resolve)));
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  let onExit;
  const exited = new Promise((resolve) => {
    onExit = resolve;
    child.once('exit', onExit);
  });
  if (child.exitCode !== null || child.signalCode !== null) {
    child.off('exit', onExit);
    return;
  }
  try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch { /* Exit proof below is authoritative. */ } }
  let stopped = await Promise.race([exited.then(() => true), sleep(1500).then(() => false)]);
  if (!stopped) {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch { /* Exit proof below is authoritative. */ } }
    stopped = await Promise.race([exited.then(() => true), sleep(1500).then(() => false)]);
  }
  if (!stopped && child.exitCode === null && child.signalCode === null) {
    child.off('exit', onExit);
    throw new Error('cleanup_unproven');
  }
}

/** Spawns an isolated Chromium process with a fresh private profile and loopback CDP endpoint. */
export async function startOwnedChromium({ chromiumPath, profilePath, timeoutMs, signal }) {
  throwIfAborted(signal);
  if (typeof chromiumPath !== 'string' || !path.isAbsolute(chromiumPath)) throw new Error('chromium_path_invalid');
  const executable = lstatSync(chromiumPath);
  if (!executable.isFile() || executable.isSymbolicLink()) throw new Error('chromium_executable_invalid');
  accessSync(chromiumPath, constants.X_OK);
  const profile = path.resolve(profilePath);
  if (existsSync(profile)) throw new Error('chromium_profile_exists');
  mkdirSync(profile, { recursive: false, mode: 0o700 });
  const privateProfile = assertPrivateDirectory(profile);
  const args = [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    '--disable-background-networking', '--remote-debugging-address=127.0.0.1',
    '--remote-debugging-port=0', `--user-data-dir=${privateProfile}`, '--window-size=1440,1000', 'about:blank',
  ];
  if (typeof process.getuid === 'function' && process.getuid() === 0) args.unshift('--no-sandbox');
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: privateProfile, LANG: 'C.UTF-8' };
  const child = spawn(chromiumPath, args, { detached: process.platform !== 'win32', stdio: 'ignore', env });
  let childErrorListener;
  const childClosed = new Promise((resolve) => child.once('close', resolve));
  const childSpawned = new Promise((resolve, reject) => {
    child.once('spawn', resolve);
    childErrorListener = () => reject(new Error('chromium_spawn_failed'));
    child.on('error', childErrorListener);
  });
  child.once('close', () => child.off('error', childErrorListener));
  const activePortPath = path.join(privateProfile, 'DevToolsActivePort');
  let activePort;
  let socketPath;
  const until = performance.now() + timeoutMs;
  let connection = null;
  try {
    await childSpawned;
    while (performance.now() < until) {
      throwIfAborted(signal);
      if (child.exitCode !== null || child.signalCode !== null) throw new Error('chromium_exited_early');
      try {
        const stat = lstatSync(activePortPath);
        if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('chromium_debug_file_invalid');
        const lines = readFileSync(activePortPath, 'utf8').trim().split('\n');
        const port = Number(lines[0]);
        if (Number.isInteger(port) && port > 0 && port <= 65535 && /^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(lines[1] ?? '')) {
          activePort = port;
          socketPath = lines[1];
          break;
        }
      } catch (error) {
        if (error instanceof Error && error.message === 'chromium_debug_file_invalid') throw error;
      }
      await sleep(25);
    }
    if (!activePort || !socketPath) throw new Error('chromium_debug_endpoint_timeout');
    const endpoint = `ws://127.0.0.1:${activePort}${socketPath}`;
    connection = await CdpConnection.connect(endpoint, timeoutMs, signal);
    const version = await connection.send('Browser.getVersion', {}, undefined, timeoutMs, signal);
    const context = await connection.send('Target.createBrowserContext', { disposeOnDetach: true },
      undefined, timeoutMs, signal);
    throwIfAborted(signal);
    if (typeof context.browserContextId !== 'string') throw new Error('chromium_context_unavailable');
    return { child, connection, browserContextId: context.browserContextId,
      version: typeof version.product === 'string' ? version.product.slice(0, 128) : 'unknown',
      stopped: false, sessionId: null, targetId: null, signal };
  } catch (error) {
    try { connection?.close(); } catch { /* Owned child exit is the cleanup proof. */ }
    try { await stopChild(child, childClosed); } catch {
      const cleanupError = new Error('cleanup_unproven');
      cleanupError.code = 'cleanup_unproven';
      cleanupError.ownedCleanupUnproven = true;
      throw cleanupError;
    }
    throw error;
  }
}

function cdpValue(result) {
  if (result.exceptionDetails) throw new Error('browser_evaluation_failed');
  return result.result?.value;
}

function endpointKind(rawUrl, method) {
  let pathname;
  try { pathname = new URL(rawUrl).pathname; } catch { return null; }
  if (method === 'POST' && pathname === '/api/review/sync') return 'syncPost';
  if (method === 'GET' && pathname === '/api/review') return 'reviewGet';
  if (method === 'GET' && pathname === '/api/review/categories') return 'categoriesGet';
  if (method === 'GET' && pathname === '/api/home/budget-summary') return 'budgetSummaryGet';
  return null;
}

function countStatus(counts, kind, status) {
  if (!Number.isInteger(status)) return;
  const key = String(status);
  counts[kind] ??= {};
  counts[kind][key] = Math.min(100, (counts[kind][key] ?? 0) + 1);
}

function addPageError(page, code) {
  const codes = page.pageErrorCodes;
  if (!codes.includes(code) && codes.length < 3) codes.push(code);
}

function requestStatusCounts(requests) {
  const counts = {};
  for (const request of requests) countStatus(counts, request.kind, request.status);
  return counts;
}

function pageDiagnostics(requests, pageErrorCodes) {
  return { httpStatusCounts: requestStatusCounts(requests), pageErrorCodes: [...pageErrorCodes] };
}
function throwPageError(page, requests = []) {
  if (!page.pageErrorCodes.length) return;
  const error = new Error('review_page_error');
  error.browserDiagnostics = pageDiagnostics(requests, page.pageErrorCodes);
  throw error;
}

function initialRequestsFailed(page) {
  return [...page.initialRequests.values()].some((request) => request.failed ||
    request.finished && (request.status !== 200 || request.bodyValidationComplete && !request.valid));
}

function initialRequestsComplete(page) {
  const requests = [...page.initialRequests.values()];
  const reviews = requests.filter((request) => request.kind === 'reviewGet');
  const categories = requests.filter((request) => request.kind === 'categoriesGet');
  return reviews.length > 0 && categories.length > 0 &&
    reviews.every((request) => request.status === 200 && request.finished &&
      request.bodyValidationComplete && request.valid) &&
    categories.every((request) => request.status === 200 && request.finished &&
      request.bodyValidationComplete && request.valid);
}

/** Validates Review API DTOs into bounded synchronization evidence. */
export function parseApiBody(request, body) {
  let envelope;
  try { envelope = JSON.parse(body); } catch { return { valid: false }; }
  if (!isObject(envelope) || envelope.status !== 'ok' || !isObject(envelope.result)) return { valid: false };
  const result = envelope.result;
  if (request.kind === 'syncPost') {
    const valid = result.synchronized === true && Number.isSafeInteger(result.failed) && result.failed === 0 &&
      Number.isSafeInteger(result.skipped) && result.skipped === 0 && Number.isSafeInteger(result.transitioned);
    const pending = isObject(result.result) ? result.result : null;
    return { valid, disposition: valid ? {
      transitioned: result.transitioned, skipped: result.skipped, failed: result.failed,
      candidateCount: Array.isArray(pending?.candidates) ? pending.candidates.length : null,
    } : null };
  }
  if (request.kind === 'reviewGet') {
    const items = result.items;
    if (!Array.isArray(items) || !Number.isSafeInteger(result.total) || result.total !== items.length || items.length > 50)
      return { valid: false };
    const ids = [];
    let currentItem = null;
    for (const item of items) {
      if (!isObject(item) || !isObject(item.reviewItem) ||
        typeof item.reviewItem.transactionId !== 'string' || item.reviewItem.transactionId.length === 0 ||
        !isObject(item.evidence) || typeof item.evidence.normalizedMerchant !== 'string' ||
        typeof item.evidence.originalImportedName !== 'string')
        return { valid: false };
      const money = item.evidence.money;
      if (!isObject(money) || typeof money.minorUnits !== 'string' ||
        !/^-?(0|[1-9]\d*)$/.test(money.minorUnits) ||
        typeof money.currency !== 'string' || !/^[A-Z]{3}$/.test(money.currency))
        return { valid: false };
      const amount = Number(money.minorUnits);
      if (!Number.isSafeInteger(amount)) return { valid: false };
      currentItem ??= { transactionId: item.reviewItem.transactionId,
        normalizedMerchant: item.evidence.normalizedMerchant,
        originalImportedName: item.evidence.originalImportedName, amount, currency: money.currency };
      ids.push(item.reviewItem.transactionId);
    }
    if (new Set(ids).size !== ids.length) return { valid: false };
    return { valid: true, queueIds: ids, queueCount: items.length, currentItem };
  }
  const categories = result.categories;
  return { valid: Array.isArray(categories) && categories.length > 0 };
}

/** Creates the owned review target after installing its normal authenticated session cookie. */
export async function createReviewPage(browser, pageUrl, cookieHeader, timeoutMs, signal = browser?.signal) {
  if (!browser || browser.stopped) throw new Error('chromium_not_active');
  throwIfAborted(signal);
  const { connection, browserContextId } = browser;
  const send = (method, params = {}, sessionId, timeout = connection.timeoutMs) =>
    connection.send(method, params, sessionId, timeout, signal);
  const target = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  if (typeof target.targetId !== 'string') throw new Error('chromium_target_unavailable');
  const attached = await send('Target.attachToTarget', { targetId: target.targetId, flatten: true });
  if (typeof attached.sessionId !== 'string') throw new Error('chromium_session_unavailable');
  browser.targetId = target.targetId;
  browser.sessionId = attached.sessionId;
  const sessionId = attached.sessionId;
  await send('Page.enable', {}, sessionId);
  await send('Runtime.enable', {}, sessionId);
  await send('Network.enable', { maxTotalBufferSize: 4_000_000, maxResourceBufferSize: 1_000_000 }, sessionId);
  const page = {
    browser, targetId: target.targetId, pageUrl, timeoutMs, sessionId, signal,
    active: null, requests: new Map(), initialRequests: new Map(), pageErrorCodes: [],
    layoutBudgetRequests: new Set(), eventRemovers: [], requestOrder: 0,
  };
  page.eventRemovers.push(connection.on('Network.requestWillBeSent', (params, sourceSession) => {
    if (sourceSession !== sessionId) return;
    const kind = endpointKind(params.request?.url, params.request?.method);
    if (kind === 'budgetSummaryGet') {
      page.layoutBudgetRequests.add(params.requestId);
      return;
    }
    if (!kind || !page.active && kind === 'syncPost') return;
    const requests = page.active ? page.requests : page.initialRequests;
    requests.set(params.requestId, { kind, epoch: page.active?.epoch ?? null, order: ++page.requestOrder,
      deadlineAt: page.active?.deadlineAt ?? null, status: null, finished: false,
      bodyValidationComplete: false, valid: false, failed: false, result: null });
  }));
  page.eventRemovers.push(connection.on('Network.responseReceived', (params, sourceSession) => {
    if (sourceSession !== sessionId) return;
    if (page.layoutBudgetRequests.has(params.requestId)) {
      if (params.response?.status >= 400) addPageError(page, 'network_error');
      return;
    }
    const request = page.requests.get(params.requestId) ?? page.initialRequests.get(params.requestId);
    if (request) request.status = params.response?.status;
  }));
  page.eventRemovers.push(connection.on('Network.loadingFinished', (params, sourceSession) => {
    if (sourceSession !== sessionId || page.layoutBudgetRequests.delete(params.requestId)) return;
    const request = page.requests.get(params.requestId) ?? page.initialRequests.get(params.requestId);
    if (!request) return;
    request.finished = true;
    if (request.status !== 200) {
      request.bodyValidationComplete = true;
      return;
    }
    const remaining = request.deadlineAt === null ? connection.timeoutMs : request.deadlineAt - performance.now();
    void connection.send('Network.getResponseBody', { requestId: params.requestId }, sessionId, remaining, signal).then((bodyResult) => {
      const raw = bodyResult.base64Encoded ? Buffer.from(bodyResult.body, 'base64').toString('utf8') : bodyResult.body;
      const parsed = parseApiBody(request, raw);
      request.valid = parsed.valid;
      request.result = parsed;
      request.bodyValidationComplete = true;
    }).catch(() => {
      request.valid = false;
      request.bodyValidationComplete = true;
    });
  }));
  page.eventRemovers.push(connection.on('Network.loadingFailed', (params, sourceSession) => {
    if (sourceSession !== sessionId) return;
    if (page.layoutBudgetRequests.delete(params.requestId)) {
      addPageError(page, 'network_error');
      return;
    }
    const request = page.requests.get(params.requestId) ?? page.initialRequests.get(params.requestId);
    if (!request) return;
    request.failed = true;
    request.finished = true;
    request.valid = false;
    request.bodyValidationComplete = true;
    addPageError(page, 'network_error');
  }));
  page.eventRemovers.push(connection.on('Runtime.exceptionThrown', (_params, sourceSession) => {
    if (sourceSession === sessionId) addPageError(page, 'runtime_exception');
  }));
  page.eventRemovers.push(connection.on('Runtime.consoleAPICalled', (params, sourceSession) => {
    if (sourceSession === sessionId && params.type === 'error') addPageError(page, 'console_error');
  }));

  const failPage = async (error) => {
    error.browserDiagnostics ??= pageDiagnostics(page.initialRequests.values(), page.pageErrorCodes);
    try { await closeReviewPage(page); } catch {
      const cleanupError = new Error('cleanup_unproven');
      cleanupError.browserDiagnostics = error.browserDiagnostics;
      throw cleanupError;
    }
    throw error;
  };
  try {
    await setCookies(page, cookieHeader);
    await send('Page.navigate', { url: pageUrl }, sessionId);
    const readyUntil = performance.now() + timeoutMs;
    while (performance.now() < readyUntil) {
      throwIfAborted(signal);
      if (initialRequestsFailed(page)) throw new Error('review_page_initial_api_failed');
      throwPageError(page, page.initialRequests.values());
      const remaining = readyUntil - performance.now();
      const state = cdpValue(await send('Runtime.evaluate', {
        expression: `(() => {
          const sync = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Sync');
          const heading = [...document.querySelectorAll('h2')].some((item) => item.textContent.trim() === 'Queue');
          const empty = (document.body?.innerText || '').includes('No items to review');
          const error = document.querySelector('[role="alert"]') !== null;
          const busy = [...document.querySelectorAll('[aria-busy="true"]')].length > 0 || !!sync?.disabled;
          return { ready: document.readyState === 'complete' && !!sync && !sync.disabled &&
            !error && !busy && (heading || empty) };
        })()`,
        returnByValue: true,
      }, sessionId, remaining));
      throwPageError(page, page.initialRequests.values());
      if (initialRequestsComplete(page) && state?.ready) {
        page.initialQueueIds = [...page.initialRequests.values()]
          .filter((request) => request.kind === 'reviewGet').at(-1).result.queueIds;
        return page;
      }
      await sleep(Math.min(50, Math.max(1, readyUntil - performance.now())));
    }
    throw new Error('review_page_ready_timeout');
  } catch (error) {
    await failPage(error instanceof Error ? error : new Error('review_page_failed'));
  }
}

async function setCookies(page, cookieHeader) {
  const url = new URL(page.pageUrl);
  const cookies = String(cookieHeader).split(';').map((part) => part.trim()).filter(Boolean).map((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) throw new Error('session_cookie_invalid');
    return { name: part.slice(0, separator), value: part.slice(separator + 1), url: url.origin, path: '/',
      httpOnly: true, secure: url.protocol === 'https:', sameSite: 'Lax' };
  });
  if (!cookies.length) throw new Error('session_cookie_missing');
  const result = await page.browser.connection.send('Network.setCookies', { cookies }, page.sessionId,
    page.browser.connection.timeoutMs, page.signal);
  return result;
}

function activeRequests(page, kind) {
  const active = page.active;
  return [...page.requests.values()].filter((request) => request.epoch === active.epoch && request.kind === kind);
}

function allRequestsComplete(page) {
  const active = page.active;
  const requests = ['syncPost', 'reviewGet', 'categoriesGet'].map((kind) => activeRequests(page, kind));
  return requests.every((entries) => entries.length === 1 && entries[0].finished &&
    entries[0].bodyValidationComplete && entries[0].valid && entries[0].status === 200);
}

function requestOrderValid(page) {
  const post = activeRequests(page, 'syncPost')[0];
  const review = activeRequests(page, 'reviewGet')[0];
  const categories = activeRequests(page, 'categoriesGet')[0];
  return !!post && !!review && !!categories && post.order < review.order && review.order < categories.order;
}

function remainingTimeout(deadlineAt) {
  const remaining = deadlineAt - performance.now();
  if (remaining <= 0) throw new Error('review_sync_deadline_exceeded');
  return remaining;
}

function sendBefore(page, method, params, deadlineAt) {
  return page.browser.connection.send(method, params, page.sessionId, remainingTimeout(deadlineAt), page.signal);
}

async function readUiState(page, expectedImportedName, deadlineAt = null) {
  const expected = typeof expectedImportedName === 'string' ? expectedImportedName.trim().toLowerCase() : '';
  const expression = `(() => {
    const sync = [...document.querySelectorAll('button')].find((button) => button.textContent.trim() === 'Sync');
    const heading = [...document.querySelectorAll('h2')].some((node) => node.textContent.trim() === 'Queue');
    const current = document.querySelector('button[aria-current="true"]');
    const rows = current?.parentElement ? [...current.parentElement.children].filter((child) => child.tagName === 'BUTTON') : [];
    const label = [...document.querySelectorAll('span')].find((node) => node.textContent.trim() === 'Admitted source display text');
    const display = label?.parentElement?.querySelector('p')?.textContent?.trim() || '';
    const expected = ${JSON.stringify(expected)};
    const error = document.querySelector('[role="alert"]') !== null;
    const busy = [...document.querySelectorAll('[aria-busy="true"]')].length > 0 || !!sync?.disabled;
    return { syncEnabled: !!sync && !sync.disabled, currentItemMatches: !!expected && display.toLowerCase() === expected,
      rowCount: rows.length, heading, error, busy };
  })()`;
  const command = deadlineAt === null
    ? page.browser.connection.send('Runtime.evaluate', { expression, returnByValue: true }, page.sessionId,
      page.browser.connection.timeoutMs, page.signal)
    : sendBefore(page, 'Runtime.evaluate', { expression, returnByValue: true }, deadlineAt);
  const state = cdpValue(await command);
  return { ready: state?.syncEnabled === true && state.currentItemMatches === true &&
    state.error === false && state.busy === false && state.heading === true && state.rowCount > 0,
    rowCount: Number.isSafeInteger(state?.rowCount) ? state.rowCount : 0,
    syncEnabled: state?.syncEnabled === true, error: state?.error === true, busy: state?.busy === true };
}

/** Performs one physical Sync click and waits for verified POST, queue, category, and rendered UI success. */
export async function performSync(page, { cookieHeader, expectedQueueIds = null, deadlineMs, onArmed }) {
  if (page.active) throw new Error('review_sync_already_active');
  throwIfAborted(page.signal);
  let tracker = null;
  try {
    throwPageError(page);
    await setCookies(page, cookieHeader);
    throwPageError(page);
    const before = cdpValue(await page.browser.connection.send('Runtime.evaluate', {
      expression: `(() => { const button = [...document.querySelectorAll('button')].find((item) => item.textContent.trim() === 'Sync'); if (!button || button.disabled) return null; const rect = button.getBoundingClientRect(); return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }; })()`,
      returnByValue: true,
    }, page.sessionId, page.browser.connection.timeoutMs, page.signal));
    if (!before || !Number.isFinite(before.x) || !Number.isFinite(before.y))
      throw new Error('review_sync_control_unavailable');
    throwIfAborted(page.signal);
    throwPageError(page);
    if (typeof onArmed === 'function') onArmed();
    throwPageError(page);
    tracker = { epoch: Symbol('review-sync'), statusCounts: {}, startedAt: performance.now() };
    tracker.deadlineAt = tracker.startedAt + deadlineMs;
    page.active = tracker;
    await sendBefore(page, 'Input.dispatchMouseEvent', {
      type: 'mousePressed', x: before.x, y: before.y, button: 'left', clickCount: 1,
    }, tracker.deadlineAt);
    await sendBefore(page, 'Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: before.x, y: before.y, button: 'left', clickCount: 1,
    }, tracker.deadlineAt);
    while (performance.now() < tracker.deadlineAt) {
      throwIfAborted(page.signal);
      const requests = ['syncPost', 'reviewGet', 'categoriesGet'].flatMap((kind) => activeRequests(page, kind));
      tracker.statusCounts = requestStatusCounts(requests);
      throwPageError(page, requests);
      if (requests.some((request) => request.failed || request.status !== null && request.status !== 200 ||
        request.finished && request.bodyValidationComplete && !request.valid))
        throw new Error('review_sync_http_or_envelope_failed');
      if (allRequestsComplete(page) && requestOrderValid(page)) {
        const review = activeRequests(page, 'reviewGet')[0].result;
        const expectedIds = Array.isArray(expectedQueueIds) ? [...expectedQueueIds].sort() : null;
        const observedIds = [...review.queueIds].sort();
        if (expectedIds && (expectedIds.length !== observedIds.length ||
          expectedIds.some((id, index) => id !== observedIds[index])))
          throw new Error('review_ui_queue_ids_changed');
        if (review.queueCount <= 0 || review.queueCount > 50) throw new Error('review_ui_queue_out_of_bounds');
        const ui = await readUiState(page, review.currentItem?.originalImportedName, tracker.deadlineAt);
        throwPageError(page, requests);
        if (performance.now() >= tracker.deadlineAt) throw new Error('review_sync_deadline_exceeded');
        if (ui.ready && ui.rowCount === review.queueCount) {
          const sync = activeRequests(page, 'syncPost')[0].result.disposition;
          if (!sync) throw new Error('review_sync_partial_transition');
          const elapsedMs = performance.now() - tracker.startedAt;
          if (performance.now() >= tracker.deadlineAt) throw new Error('review_sync_deadline_exceeded');
          throwPageError(page, requests);
          return { elapsedMs, status: 'completed', censored: false, uiSettled: true,
            queueIds: review.queueIds, queueCount: review.queueCount, currentItem: review.currentItem,
            candidateCount: sync.candidateCount, syncDisposition: sync, httpStatusCounts: tracker.statusCounts,
            pageErrorCodes: [...page.pageErrorCodes], visibleCount: ui.rowCount, syncEnabled: ui.syncEnabled };
        }
      }
      await sleep(Math.min(25, Math.max(1, tracker.deadlineAt - performance.now())));
    }
    throw new Error('review_sync_deadline_exceeded');
  } catch (error) {
    if (error && typeof error === 'object') {
      const requests = tracker
        ? ['syncPost', 'reviewGet', 'categoriesGet'].flatMap((kind) => activeRequests(page, kind)) : [];
      error.browserDiagnostics ??= pageDiagnostics(requests, page.pageErrorCodes);
    }
    throw error;
  } finally {
    page.active = null;
  }
}

/** Captures a PNG only after the admitted queue and enabled Sync control are settled. */
export async function captureReviewScreenshot(page, expectedImportedName) {
  throwPageError(page);
  const state = await readUiState(page, expectedImportedName);
  throwPageError(page);
  if (!state.ready) throw new Error('review_screenshot_state_unsettled');
  const screenshot = await page.browser.connection.send('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true,
  }, page.sessionId, page.browser.connection.timeoutMs, page.signal);
  throwPageError(page);
  if (typeof screenshot.data !== 'string' || !screenshot.data) throw new Error('review_screenshot_unavailable');
  return Buffer.from(screenshot.data, 'base64');
}

/** Closes the owned target and unregisters its CDP observers. */
export async function closeReviewPage(page) {
  if (!page || page.closed) return;
  for (const remove of page.eventRemovers ?? []) remove();
  if (page.browser && page.targetId)
    await page.browser.connection.send('Target.closeTarget', { targetId: page.targetId }, undefined);
  page.closed = true;
  if (page.browser) {
    page.browser.sessionId = null;
    page.browser.targetId = null;
  }
}

/** Disposes the private browser context and terminates only the spawned Chromium process. */
export async function closeOwnedChromium(browser) {
  if (!browser || browser.stopped) return;
  let disposeFailed = false;
  if (browser.browserContextId) {
    try {
      await browser.connection.send('Target.disposeBrowserContext', { browserContextId: browser.browserContextId });
    } catch {
      disposeFailed = true;
    }
  }
  try { browser.connection.close(); } catch { disposeFailed = true; }
  await stopChild(browser.child);
  browser.stopped = true;
  if (disposeFailed) throw new Error('cleanup_unproven');
}
