import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { describe, expect, it } from 'vitest';

import { ScenarioHttpClient } from '../src/workflow-setup.js';

async function loopbackServer(
  handler: (request: IncomingMessage, response: ServerResponse) => void,
): Promise<{ origin: string; close: () => Promise<void> }> {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Loopback server did not bind a TCP port');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      if (server.listening) await new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
      });
    },
  };
}

describe('ScenarioHttpClient cancellation', () => {
  it('aborts a request stalled before headers and sends no request after abort', async () => {
    let requestCount = 0;
    let resolveRequest!: () => void;
    let resolveClosed!: () => void;
    const requestReceived = new Promise<void>((resolve) => { resolveRequest = resolve; });
    const responseClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const server = await loopbackServer((_request, response) => {
      requestCount += 1;
      response.once('close', resolveClosed);
      resolveRequest();
    });
    const controller = new AbortController();
    const client = new ScenarioHttpClient(server.origin, server.origin, undefined, controller.signal);
    try {
      const pending = client.get('/stalled-before-headers');
      await requestReceived;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await responseClosed;

      await expect(client.post('/after-abort', {
        toJSON: () => { throw new Error('aborted request body must not be serialized'); },
      })).rejects.toMatchObject({ name: 'AbortError' });
      expect(requestCount).toBe(1);
    } finally {
      await server.close();
    }
  });

  it('aborts while reading a JSON body after receiving headers and a partial chunk', async () => {
    let resolveBodyStarted!: () => void;
    let resolveClosed!: () => void;
    const bodyStarted = new Promise<void>((resolve) => { resolveBodyStarted = resolve; });
    const responseClosed = new Promise<void>((resolve) => { resolveClosed = resolve; });
    const server = await loopbackServer((_request, response) => {
      response.once('close', resolveClosed);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.flushHeaders();
      response.write('{"partial":', resolveBodyStarted);
    });
    const controller = new AbortController();
    const client = new ScenarioHttpClient(server.origin, server.origin, undefined, controller.signal);
    try {
      const pending = client.get('/stalled-json-body');
      await bodyStarted;
      controller.abort();
      await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
      await responseClosed;
    } finally {
      await server.close();
    }
  });
});
