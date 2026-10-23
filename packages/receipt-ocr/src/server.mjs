import { createServer } from 'node:http';
import { ENGINE_VERSION, MODEL_VERSION } from './extract.mjs';

const MAX_IMAGE = 5 * 1024 * 1024;
const PNG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
function validMagic(bytes, type) {
  return type === 'image/png'
    ? bytes.length > 8 && bytes.subarray(0, 8).equals(PNG)
    : bytes.length >= 4 &&
        bytes[0] === 255 &&
        bytes[1] === 216 &&
        bytes[2] === 255 &&
        bytes[bytes.length - 2] === 255 &&
        bytes[bytes.length - 1] === 217;
}
function reply(response, status, value) {
  if (response.destroyed) return;
  let body = JSON.stringify(value);
  if (Buffer.byteLength(body) > 1024 * 1024) {
    status = 422;
    body = JSON.stringify({ error: 'extraction_failed' });
  }
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
    Connection: 'close',
    'X-Content-Type-Options': 'nosniff',
  });
  response.end(body);
}

/** Create the isolated OCR HTTP service; callers must verify its runtime first. */
export function createReceiptOcrServer({ extract }) {
  let busy = false;
  const server = createServer(async (request, response) => {
    if (request.url === '/health' && request.method === 'GET') {
      reply(response, 200, {
        status: 'ok',
        engineVersion: ENGINE_VERSION,
        modelVersion: MODEL_VERSION,
      });
      return;
    }
    if (request.url !== '/v1/extract') {
      reply(response, 404, { error: 'not_found' });
      return;
    }
    if (request.method !== 'POST') {
      reply(response, 405, { error: 'method_not_allowed' });
      return;
    }
    const type = request.headers['content-type'];
    if (type !== 'image/jpeg' && type !== 'image/png') {
      reply(response, 415, { error: 'unsupported_image' });
      return;
    }
    if (Number(request.headers['content-length']) > MAX_IMAGE) {
      reply(response, 413, { error: 'image_too_large' });
      return;
    }
    if (busy) {
      reply(response, 429, { error: 'busy' });
      return;
    }
    busy = true;
    const controller = new AbortController();
    const abort = () => controller.abort();
    request.on('aborted', abort);
    response.on('close', () => {
      if (!response.writableFinished) abort();
    });
    try {
      const chunks = [];
      let bytes = 0;
      for await (const chunk of request) {
        bytes += chunk.length;
        if (bytes > MAX_IMAGE) {
          reply(response, 413, { error: 'image_too_large' });
          return;
        }
        chunks.push(chunk);
      }
      const image = Buffer.concat(chunks);
      if (!validMagic(image, type)) {
        reply(response, 422, { error: 'invalid_image' });
        return;
      }
      reply(response, 200, await extract(image, { signal: controller.signal }));
    } catch (error) {
      const status =
        error.code === 'extraction_timeout' ? 504 : error.code === 'engine_unavailable' ? 503 : 422;
      reply(response, status, {
        error:
          status === 504
            ? 'extraction_timeout'
            : status === 503
              ? 'engine_unavailable'
              : 'extraction_failed',
      });
    } finally {
      request.removeListener('aborted', abort);
      busy = false;
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 5000;
  server.maxConnections = 16;
  return server;
}
