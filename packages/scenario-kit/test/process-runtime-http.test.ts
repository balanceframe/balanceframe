import { ChildProcess } from 'node:child_process';
import { PassThrough } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:child_process')>(),
  spawn: mocks.spawn,
}));

import {
  createOwnedScenarioRoot, discardOwnedScenarioRoot, startScenarioShell, stopScenarioProcesses,
  type ScenarioProcesses,
} from '../src/process-runtime.js';

let child: ChildProcess;
let root: string;
let handle: ScenarioProcesses | undefined;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date', 'setTimeout', 'clearTimeout'] });
  child = Object.assign(new ChildProcess(), { stdout: new PassThrough(), stderr: new PassThrough() });
  vi.spyOn(child, 'kill').mockImplementation((signal) => {
    Object.defineProperty(child, 'signalCode', { value: typeof signal === 'string' ? signal : 'SIGTERM' });
    child.emit('exit', null, child.signalCode);
    child.emit('close', null, child.signalCode);
    return true;
  });
  mocks.spawn.mockReset().mockReturnValue(child);
  root = createOwnedScenarioRoot();
});

afterEach(async () => {
  if (handle) await stopScenarioProcesses(handle);
  else discardOwnedScenarioRoot(root);
  handle = undefined;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function start(): Promise<PromiseSettledResult<ScenarioProcesses>> {
  try {
    handle = await startScenarioShell({ root, webEntry: fileURLToPath(import.meta.url) });
    return { status: 'fulfilled', value: handle };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

async function spawned(): Promise<void> {
  while (mocks.spawn.mock.calls.length === 0) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function expectCleanReadiness(): void {
  expect(vi.getTimerCount()).toBe(0);
  expect(child.listenerCount('exit')).toBe(0);
  expect(child.listenerCount('error')).toBe(0);
}

describe('scenario HTTP readiness lifecycle (mocked children only)', () => {
  it.each([200, 499])('accepts HTTP %i and releases its body, timer and child listeners', async (status) => {
    const response = new Response('unused startup page', { status });
    const cancel = vi.spyOn(response.body!, 'cancel');
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(response));
    expect((await start()).status).toBe('fulfilled');
    expect(cancel).toHaveBeenCalledOnce();
    expectCleanReadiness();
  });

  it('paces connection-refused retries within the existing startup deadline', async () => {
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('ECONNREFUSED'))
      .mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetch);
    const started = start();
    await spawned();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(99);
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect((await started).status).toBe('fulfilled');
    expect(fetch).toHaveBeenCalledTimes(2);
    expectCleanReadiness();
  });

  it('releases a 503 body and retries rather than declaring readiness', async () => {
    const unavailable = new Response('not ready', { status: 503 });
    const cancel = vi.spyOn(unavailable.body!, 'cancel');
    const fetch = vi.fn().mockResolvedValueOnce(unavailable).mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetch);
    const started = start();
    await spawned();
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(100);
    expect((await started).status).toBe('fulfilled');
    expect(fetch).toHaveBeenCalledTimes(2);
    expectCleanReadiness();
  });

  it('aborts an outstanding probe and releases listeners when its child exits', async () => {
    let probeSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      probeSignal = options.signal ?? undefined;
      probeSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const started = start();
    await spawned();
    Object.defineProperty(child, 'exitCode', { value: 17 });
    child.emit('exit', 17, null);
    expect(await started).toMatchObject({ status: 'rejected', reason: { message: 'Nuxt shell child exited before readiness (code 17)' } });
    expect(probeSignal?.aborted).toBe(true);
    expectCleanReadiness();
  });

  it('cancels a queued retry when its child exits', async () => {
    const fetch = vi.fn().mockRejectedValueOnce(new Error('ECONNREFUSED')).mockResolvedValue(new Response(null));
    vi.stubGlobal('fetch', fetch);
    const started = start();
    await spawned();
    Object.defineProperty(child, 'exitCode', { value: 17 });
    child.emit('exit', 17, null);
    expect(await started).toMatchObject({ status: 'rejected', reason: { message: 'Nuxt shell child exited before readiness (code 17)' } });
    expectCleanReadiness();
    await vi.advanceTimersByTimeAsync(100);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('cleans up an outstanding probe when its child emits a startup error', async () => {
    let probeSignal: AbortSignal | undefined;
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      probeSignal = options.signal ?? undefined;
      probeSignal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const started = start();
    await spawned();
    child.emit('error', new Error('spawn refused'));
    expect(await started).toMatchObject({ status: 'rejected', reason: { message: 'Nuxt shell child failed to start: spawn refused' } });
    expect(probeSignal?.aborted).toBe(true);
    expectCleanReadiness();
  });

  it('keeps the 1500ms probe bound and 45000ms startup deadline on an unresponsive server', async () => {
    const signals: AbortSignal[] = [];
    vi.stubGlobal('fetch', vi.fn((_url: string, options: RequestInit) => new Promise<Response>((_resolve, reject) => {
      const signal = options.signal!;
      signals.push(signal);
      signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    })));
    const started = start();
    await spawned();
    await vi.advanceTimersByTimeAsync(1499);
    expect(signals).toHaveLength(1);
    expect(signals[0].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(signals[0].aborted).toBe(true);
    await vi.advanceTimersByTimeAsync(43_500);
    expect(await started).toMatchObject({ status: 'rejected', reason: { message: 'Nuxt shell child did not become ready over HTTP' } });
    expect(signals.every((signal) => signal.aborted)).toBe(true);
    expectCleanReadiness();
  });
});
