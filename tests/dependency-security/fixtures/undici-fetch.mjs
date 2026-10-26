import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { gzipSync, deflateSync, brotliCompressSync } from 'node:zlib';

const { fetch, Client } = createRequire(import.meta.url)(process.argv[2]);
const scenario = process.argv[3];
const text = 'owned synthetic dependency fixture';
const sockets = new Set();
let socketClosed;
const closed = new Promise((resolve) => { socketClosed = resolve; });
const server = createServer((socket) => {
  sockets.add(socket);
  socket.once('close', () => { sockets.delete(socket); socketClosed(); });
  socket.once('data', (request) => {
    const path = request.toString().split(' ')[1];
    let body = Buffer.from(text);
    let encoding;
    let length;
    if (scenario === 'excess-early-close') {
      encoding = Array(6).fill('gzip').join(', ');
      body = Buffer.alloc(0);
      length = 1;
    } else if (path === '/gzip') {
      encoding = 'gzip'; body = gzipSync(body);
    } else if (path === '/deflate') {
      encoding = 'deflate'; body = deflateSync(body);
    } else if (path === '/br') {
      encoding = 'br'; body = brotliCompressSync(body);
    } else if (path === '/five') {
      encoding = Array(5).fill('gzip').join(', ');
      for (let i = 0; i < 5; i++) body = gzipSync(body);
    } else if (path === '/bad-gzip') {
      encoding = 'gzip';
    } else if (path === '/truncated') {
      length = body.length + 1;
    }
    const headers = ['HTTP/1.1 200 OK', 'Connection: close', `Content-Length: ${length ?? body.length}`];
    if (encoding) headers.push(`Content-Encoding: ${encoding}`);
    socket.end(Buffer.concat([Buffer.from(headers.join('\r\n') + '\r\n\r\n'), body]));
  });
});

let client;
try {
  await once(server.listen(0, '127.0.0.1'), 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  client = new Client(origin, { headersTimeout: 1000, bodyTimeout: 1000 });
  const request = (path) => fetch(origin + path, { dispatcher: client, signal: AbortSignal.timeout(2000) });
  if (scenario === 'excess-early-close') {
    // GHSA-xjj6-f33q-929c / upstream commit 1325a87dfb: six codings, no promised body.
    await assert.rejects(request('/'), (error) => {
      assert.equal(error.name, 'TypeError');
      assert.match(error.cause?.message ?? '', /too many content-encodings.*6.*5/);
      return true;
    });
    await closed;
  } else {
    for (const path of ['/', '/gzip', '/deflate', '/br', '/five']) {
      const response = await request(path);
      assert.equal(response.status, 200);
      assert.equal(await response.text(), text);
    }
    for (const path of ['/bad-gzip', '/truncated']) {
      await assert.rejects(async () => (await request(path)).text(), TypeError);
    }
  }
} finally {
  if (client) await client.destroy();
  for (const socket of sockets) socket.destroy();
  await new Promise((resolve) => server.close(resolve));
}
console.log(`${scenario}: passed`);
