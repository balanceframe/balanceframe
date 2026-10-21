import { afterEach, describe, expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { chmod, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { createExtractor, verifyRuntime } from '../src/extract.mjs';
import { createReceiptOcrServer } from '../src/server.mjs';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
  'base64',
);
const hash = (value) => createHash('sha256').update(value).digest('hex');
const cleanup = [];
afterEach(async () => {
  for (const task of cleanup.splice(0).reverse()) await task();
});
async function scratch() {
  const path = await mkdtemp(join(tmpdir(), 'receipt-ocr-test-'));
  cleanup.push(() => rm(path, { recursive: true, force: true }));
  return path;
}
async function fakeCommand(body) {
  const directory = await scratch();
  const command = join(directory, 'fake-tesseract');
  await writeFile(command, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  await chmod(command, 0o700);
  return command;
}
async function running(extract) {
  const server = createReceiptOcrServer({ extract });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise((resolve) => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}
function post(url, bytes = png, type = 'image/png') {
  return fetch(`${url}/v1/extract`, {
    method: 'POST',
    headers: { 'Content-Type': type },
    body: bytes,
  });
}
const synthetic = async (bytes) => ({
  engine: 'tesseract',
  engineVersion: '5.5.3',
  modelVersion: '4.1.0',
  text: 'SYNTHETIC TOTAL 12.34',
  contentHash: hash(bytes),
});

describe('bounded child process', () => {
  it('uses fixed arguments, private files, exact raw hash and cleanup', async () => {
    const directory = await scratch();
    const command = await fakeCommand(
      `const fs=require('node:fs');const path=require('node:path');const args=process.argv.slice(2);if(args[1]!=='stdout'||args[2]!=='-l'||args[3]!=='eng'||args[4]!=='--tessdata-dir'||args[6]!=='--psm'||args[7]!=='6')process.exit(10);if((fs.statSync(args[0]).mode&511)!==384||(fs.statSync(path.dirname(args[0])).mode&511)!==448)process.exit(11);process.stdout.write('SYNTHETIC TOTAL 12.34');`,
    );
    const result = await createExtractor({ command, tempRoot: directory })(png);
    expect(result).toEqual(await synthetic(png));
    expect(await readdir(directory)).toEqual([]);
  });
  it('bounds time, output and stderr without retaining failed images', async () => {
    for (const [body, options, code] of [
      ['setTimeout(()=>{},10000)', { timeoutMs: 50 }, 'extraction_timeout'],
      ["process.stdout.write('x'.repeat(1000))", { outputLimit: 64 }, 'extraction_failed'],
      ["process.stderr.write('x'.repeat(70000))", {}, 'extraction_failed'],
      ["process.stderr.write('PRIVATE-RECEIPT-SENTINEL');process.exit(2)", {}, 'extraction_failed'],
    ]) {
      const directory = await scratch();
      const command = await fakeCommand(body);
      await expect(
        createExtractor({ command, tempRoot: directory, ...options })(png),
      ).rejects.toMatchObject({ code });
      expect(await readdir(directory)).toEqual([]);
    }
  });
  it('cancels extraction and cleans files when the client aborts', async () => {
    const directory = await scratch();
    const command = await fakeCommand('setTimeout(()=>{},10000)');
    const controller = new AbortController();
    const result = createExtractor({ command, tempRoot: directory })(png, {
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(result).rejects.toMatchObject({ code: 'extraction_aborted' });
    expect(await readdir(directory)).toEqual([]);
  });
  it('handles missing executable, empty OCR text and already aborted requests', async () => {
    const directory = await scratch();
    await expect(
      createExtractor({ command: join(directory, 'absent'), tempRoot: directory })(png),
    ).rejects.toMatchObject({ code: 'extraction_failed' });
    const command = await fakeCommand('process.exit(0)');
    expect((await createExtractor({ command, tempRoot: directory })(png)).text).toBe('');
    await expect(
      createExtractor({ command, tempRoot: directory })(png, { signal: AbortSignal.abort() }),
    ).rejects.toMatchObject({ code: 'extraction_aborted' });
    expect(await readdir(directory)).toEqual([]);
  });
  it('verifies exact engine, Leptonica, model version and model checksum at startup', async () => {
    const directory = await scratch();
    await writeFile(join(directory, 'eng.traineddata'), 'synthetic-model');
    await writeFile(join(directory, 'MODEL_VERSION'), '4.1.0\n');
    const command = await fakeCommand(
      "process.stdout.write('tesseract 5.5.3\\n leptonica-1.87.0\\n')",
    );
    const options = { command, tessdata: directory, expectedModelHash: hash('synthetic-model') };
    await expect(verifyRuntime(options)).resolves.toBeUndefined();
    const wrong = await fakeCommand(
      "process.stdout.write('tesseract 5.5.0\\n leptonica-1.87.0\\n')",
    );
    await expect(verifyRuntime({ ...options, command: wrong })).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
    await writeFile(join(directory, 'MODEL_VERSION'), 'other');
    await expect(verifyRuntime(options)).rejects.toMatchObject({ code: 'engine_unavailable' });
    await writeFile(join(directory, 'MODEL_VERSION'), '4.1.0');
    await expect(verifyRuntime({ ...options, expectedModelHash: 'wrong' })).rejects.toMatchObject({
      code: 'engine_unavailable',
    });
    await expect(
      verifyRuntime({ ...options, tessdata: join(directory, 'absent') }),
    ).rejects.toMatchObject({ code: 'engine_unavailable' });
  });
});

describe('private binary HTTP contract', () => {
  it('returns pinned metadata and raw hash; health has no extracted content', async () => {
    const url = await running(synthetic);
    const response = await post(url);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual(await synthetic(png));
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(await (await fetch(`${url}/health`)).json()).toEqual({
      status: 'ok',
      engineVersion: '5.5.3',
      modelVersion: '4.1.0',
    });
    expect((await fetch(`${url}/other`)).status).toBe(404);
    expect((await fetch(`${url}/v1/extract`)).status).toBe(405);
  });
  it('rejects SVG/PDF, type mismatch, empty image and bad magic before extraction', async () => {
    let calls = 0;
    const url = await running(async (bytes) => {
      calls++;
      return synthetic(bytes);
    });
    for (const [bytes, type, status] of [
      [Buffer.from('<svg/>'), 'image/svg+xml', 415],
      [png, 'application/json', 415],
      [png, 'image/jpeg', 422],
      [Buffer.alloc(0), 'image/png', 422],
      [Buffer.from('not-a-png'), 'image/png', 422],
    ]) {
      expect((await post(url, bytes, type)).status).toBe(status);
    }
    expect(calls).toBe(0);
  });
  it('bounds both content-length and streamed bytes to five MiB', async () => {
    const url = await running(synthetic);
    expect((await post(url, Buffer.alloc(5 * 1024 * 1024 + 1))).status).toBe(413);
    const response = await new Promise((resolve, reject) => {
      const req = request(
        `${url}/v1/extract`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'image/png', 'Transfer-Encoding': 'chunked' },
        },
        (res) => {
          res.resume();
          res.on('end', () => resolve(res.statusCode));
        },
      );
      req.on('error', reject);
      req.end(Buffer.alloc(5 * 1024 * 1024 + 1));
    });
    expect(response).toBe(413);
  });
  it('allows one extraction and immediately refuses concurrent work', async () => {
    let release;
    let started;
    const entered = new Promise((resolve) => {
      started = resolve;
    });
    const url = await running(async (bytes) => {
      started();
      await new Promise((resolve) => {
        release = resolve;
      });
      return synthetic(bytes);
    });
    const first = post(url);
    await entered;
    expect((await post(url)).status).toBe(429);
    expect((await fetch(`${url}/health`)).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect((await post(url, Buffer.from('invalid'))).status).toBe(422);
  });
  it('bounds encoded JSON responses even when OCR text contains escaped characters', async () => {
    const url = await running(async (bytes) => ({
      ...(await synthetic(bytes)),
      text: '\n'.repeat(600000),
    }));
    const response = await post(url);
    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ error: 'extraction_failed' });
  });
  it('checks JPEG header and terminal marker before invoking the decoder', async () => {
    const url = await running(synthetic);
    const jpeg = Buffer.from([255, 216, 255, 224, 0, 2, 255, 217]);
    expect((await post(url, jpeg, 'image/jpeg')).status).toBe(200);
    expect((await post(url, jpeg.subarray(0, -2), 'image/jpeg')).status).toBe(422);
  });
  it('maps process failures without leaking text and releases the concurrency slot', async () => {
    for (const [code, status] of [
      ['extraction_timeout', 504],
      ['extraction_failed', 422],
      ['engine_unavailable', 503],
      ['unknown', 422],
    ]) {
      const url = await running(async () => {
        throw Object.assign(new Error('PRIVATE-RECEIPT-SENTINEL'), { code });
      });
      const response = await post(url);
      expect(response.status).toBe(status);
      const text = await response.text();
      expect(text).not.toContain('PRIVATE-RECEIPT-SENTINEL');
      expect((await post(url)).status).toBe(status);
    }
  });
  it('aborts the child when a connected caller disconnects', async () => {
    let entered;
    let aborted;
    const started = new Promise((resolve) => {
      entered = resolve;
    });
    const stopped = new Promise((resolve) => {
      aborted = resolve;
    });
    const url = await running(async (_bytes, { signal }) => {
      entered();
      await new Promise((resolve, reject) =>
        signal.addEventListener(
          'abort',
          () => {
            aborted();
            reject(Object.assign(new Error('aborted'), { code: 'extraction_aborted' }));
          },
          { once: true },
        ),
      );
    });
    const req = request(`${url}/v1/extract`, {
      method: 'POST',
      headers: { 'Content-Type': 'image/png' },
    });
    req.on('error', () => {});
    req.end(png);
    await started;
    req.destroy();
    await stopped;
  });
});
