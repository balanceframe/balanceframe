import { execFileSync, spawn } from 'node:child_process';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { seedFixtureData } from './helpers';

const mocks = vi.hoisted(() => {
  // The version guard loads helpers before this file installs its transport mocks.
  vi.resetModules();
  return {
    populate: vi.fn<(_ledger: unknown) => Promise<void>>(),
    sync: vi.fn<() => Promise<void>>(),
  };
});

vi.mock('./actual-client.js', () => ({
  init: vi.fn(),
  shutdown: vi.fn(),
  createBudget: vi.fn(),
  deleteBudget: vi.fn(),
  downloadBudget: vi.fn(),
  sync: mocks.sync,
}));
vi.mock('../../packages/scenario-kit/src/actual-seed.js', () => ({
  populateActualBudget: mocks.populate,
}));

// A separate event loop can retire the socket while the SDK's synchronous work
// keeps this client's event loop from observing its close event.
const serverSource = String.raw`
  import http from 'node:http';
  let nextSocketId = 0;
  let warmSocket;
  const socketIds = new WeakMap();
  const server = http.createServer(async (request, response) => {
    if (request.url === '/warm') {
      warmSocket = request.socket;
      response.end('warm');
    } else if (request.url === '/retire-warm') {
      warmSocket.once('close', () => response.end('retired'));
      warmSocket.destroy();
    } else {
      let body = '';
      for await (const chunk of request) body += chunk;
      response.setHeader('Content-Type', 'application/json');
      response.end(JSON.stringify({
        warmSocketId: socketIds.get(warmSocket),
        postSocketId: socketIds.get(request.socket),
        method: request.method,
        body,
      }));
    }
  });
  server.on('connection', (socket) => socketIds.set(socket, ++nextSocketId));
  server.listen(0, '127.0.0.1', () => {
    if (process.connected) process.send({ port: server.address().port }, () => {});
  });
  process.on('message', (message) => {
    if (message === 'stop') server.close(() => {
      if (process.connected) process.disconnect();
    });
  });
  setTimeout(() => process.exit(1), 10_000).unref();
`;

const retireSource = String.raw`
  const response = await fetch(process.argv[1]);
  if (!response.ok || await response.text() !== 'retired') process.exitCode = 1;
`;

beforeEach(() => vi.resetAllMocks());

describe('fixture seed network cooperation', () => {
  it('observes an idle socket closing during local population before syncing', async () => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', serverSource], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
    });
    let stderr = '';
    child.stderr!.setEncoding('utf8').on('data', (chunk: string) => { stderr += chunk; });
    const exited = new Promise<{ code: number | null; signal: string | null }>((resolve) => {
      child.once('close', (code, signal) => resolve({ code, signal }));
    });
    const ready = new Promise<number>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => reject(new Error('Inert server exited before readiness')));
      child.once('message', (message: unknown) => {
        if (typeof message !== 'object' || message === null || !('port' in message) ||
            typeof message.port !== 'number') {
          reject(new Error('Inert server returned invalid readiness'));
        } else resolve(message.port);
      });
    });
    try {
      const url = `http://127.0.0.1:${await ready}`;
      await (await fetch(`${url}/warm`)).text();
      await new Promise(setImmediate);
      mocks.populate.mockImplementationOnce(async () => {
        // ACK follows the server-side close; this synchronous control client
        // prevents our fetch dispatcher from processing that pending event.
        execFileSync(process.execPath, ['--input-type=module', '-e', retireSource,
          `${url}/retire-warm`], { timeout: 5_000, stdio: 'pipe' });
      });
      mocks.sync.mockImplementationOnce(async () => {
        const response = await fetch(`${url}/inert`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/actual-sync' },
          body: '{"fixture":"inert"}',
        });
        expect(response.status).toBe(200);
        const result: unknown = await response.json();
        expect(result).toEqual({
          warmSocketId: expect.any(Number),
          postSocketId: expect.any(Number),
          method: 'POST',
          body: '{"fixture":"inert"}',
        });
        const sockets = result as { warmSocketId: number; postSocketId: number };
        expect(sockets.postSocketId).not.toBe(sockets.warmSocketId);
      });

      await seedFixtureData();
      expect(mocks.populate).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
        accounts: expect.arrayContaining([expect.objectContaining({ id: 'a_1' })]),
      }));
      expect(mocks.sync).toHaveBeenCalledExactlyOnceWith();
    } finally {
      if (child.connected) child.send('stop', () => {});
      expect(await exited, stderr).toEqual({ code: 0, signal: null });
    }
  });

  it('does not sync when canonical population fails', async () => {
    const error = new Error('fixture population failed');
    mocks.populate.mockRejectedValueOnce(error);
    await expect(seedFixtureData()).rejects.toBe(error);
    expect(mocks.sync).not.toHaveBeenCalled();
  });
});
